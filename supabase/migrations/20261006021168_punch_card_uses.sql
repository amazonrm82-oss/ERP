-- =============================================================================
-- PKG-02: a customer's entries balance: a held meeting uses an entry of a punch card
-- =============================================================================
-- "יתרת כניסות ללקוח: פגישה שהתקיימה מסוג מתאים מורידה כניסה (CAL-01), ומי שמורשה יכול להחזיר כניסה שירדה, עם נימוק. היתרה
-- מוצגת בכרטיס הלקוח ובזמן קביעת תור" (SPEC-ADDITIONS, wave 3; defaults of 22.9: after its validity a card's balance is shown
-- and cannot be used).
--
-- * public.punch_card_uses: one used entry of one card, made by a meeting (meeting_id; composite FK set null of the column, so
--   the entry stays when the meeting goes) on its day in the business's zone (used_on). Never deleted by a person: an entry is
--   given back with returned_at, return_kind 'meeting' (the meeting left 'held' or was removed) or 'manual' (a person, reason
--   1..500 required), returned_by. Read by whoever reads the card (so the contact). No client write grant at all.
--   Balance = entries_total - entries not given back (computed when read, never stored).
-- * Trigger meetings_punch_card_use (definer, after insert or update of status on meetings): a meeting that becomes 'held'
--   (inserted held, or moved into held) with a contact and a meeting type, and no live entry yet, uses one entry of that
--   contact's card: active, not expired on the meeting's day (expires_on is the last usable day), whose product lists the
--   meeting's type, with an entry left; the card that expires first, then the oldest. The contact's active cards are locked
--   first (FOR UPDATE, by id), so two meetings never use the same last entry. No card = nothing happens. A meeting that leaves
--   'held' gives its live entry back (once per meeting: a partial unique index keeps one live entry per meeting). A change of
--   a held meeting's contact or type does not move its entry (accepted; a merge moves meetings and cards apart). The plan key
--   is not asked here: entries of cards already sold keep being counted after a downgrade.
--   Trigger meetings_punch_card_return (definer, before delete on meetings) gives a removed meeting's live entry back.
-- * public.punch_card_use_return(org, use, reason) (definer, authenticated): owners, admins and managers (by role) of a writable
--   business who read the card's contact give a used entry back with a reason (hint punch_card:reason; given back already:
--   punch_card_use:returned).
-- Review finding 4: a meeting dated before the card's activation day never uses an entry. Finding 5 (accepted): a meeting
-- marked held again after a manual return uses a new entry. Owner (87) ב: the entries are in the action log and the
-- privacy erasure reaches them (app.punch_cards_erase redefined from 021166).
-- Every statement is safe to run twice. No drop statement, no delete.

create table if not exists public.punch_card_uses (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  card_id          uuid not null,
  meeting_id       uuid,
  used_on          date not null,
  returned_at      timestamptz,
  returned_by      uuid references auth.users (id) on delete set null,
  return_kind      text check (return_kind is null or return_kind in ('meeting', 'manual')),
  return_reason    text check (return_reason is null or char_length(return_reason) between 1 and 500),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint punch_card_uses_card_fk foreign key (organization_id, card_id)
    references public.punch_cards (organization_id, id) on delete cascade,
  constraint punch_card_uses_meeting_fk foreign key (organization_id, meeting_id)
    references public.meetings (organization_id, id) on delete set null (meeting_id),
  constraint punch_card_uses_return_shape check (
    ((returned_at is null) = (return_kind is null))
    and (return_kind is distinct from 'manual' or return_reason is not null)
    and (returned_at is not null or return_reason is null)
  )
);
create index if not exists punch_card_uses_card_idx on public.punch_card_uses (organization_id, card_id);
create index if not exists punch_card_uses_meeting_idx on public.punch_card_uses (organization_id, meeting_id);
create unique index if not exists punch_card_uses_live_meeting_idx on public.punch_card_uses (organization_id, meeting_id)
  where returned_at is null and meeting_id is not null;

alter table public.punch_card_uses enable row level security;
revoke all on public.punch_card_uses from anon, authenticated;
grant select on public.punch_card_uses to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'punch_card_uses' and policyname = 'punch_card_uses_select') then
    -- whoever reads the card (so its contact) reads its entries
    create policy punch_card_uses_select on public.punch_card_uses for select to authenticated
      using (app.is_member(organization_id)
             and exists (select 1 from public.punch_cards c
                          where c.organization_id = punch_card_uses.organization_id and c.id = punch_card_uses.card_id));
  end if;
end;
$$;

create or replace trigger punch_card_uses_touch before update on public.punch_card_uses
  for each row execute function app.touch_row();
-- owner (87) ב: in the action log too; the erasure below reaches them
create or replace trigger punch_card_uses_audit after insert or update or delete on public.punch_card_uses
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- A held meeting uses an entry; leaving 'held' gives it back
-- ----------------------------------------------------------------------------
create or replace function app.meetings_punch_card_use() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_day date;
  v_card uuid;
begin
  if tg_op = 'UPDATE' and old.status = 'held' and new.status is distinct from 'held' then
    update public.punch_card_uses u
       set returned_at = now(), returned_by = auth.uid(), return_kind = 'meeting'
     where u.organization_id = new.organization_id and u.meeting_id = new.id and u.returned_at is null;
  end if;
  if new.status = 'held' and (tg_op = 'INSERT' or old.status is distinct from 'held')
     and new.contact_id is not null and new.meeting_type_id is not null then
    if exists (select 1 from public.punch_card_uses u
                where u.organization_id = new.organization_id and u.meeting_id = new.id and u.returned_at is null) then
      return null;
    end if;
    -- the contact's active cards, locked in one order first, so two meetings never take the same last entry
    perform 1 from public.punch_cards c
      where c.organization_id = new.organization_id and c.contact_id = new.contact_id and c.status = 'active'
      order by c.id
      for update;
    v_day := (new.starts_at at time zone app.intake_zone(
               (select o.timezone from public.organizations o where o.id = new.organization_id)))::date;
    select c.id into v_card
      from public.punch_cards c
      join public.products p on p.organization_id = c.organization_id and p.id = c.product_id
     where c.organization_id = new.organization_id and c.contact_id = new.contact_id and c.status = 'active'
       and (c.expires_on is null or c.expires_on >= v_day)
       -- review finding 4: never a meeting dated before the card's activation day
       and c.activated_at is not null
       and v_day >= (c.activated_at at time zone app.intake_zone(
                       (select o.timezone from public.organizations o where o.id = new.organization_id)))::date
       and new.meeting_type_id = any(coalesce(p.punch_meeting_type_ids, '{}'::uuid[]))
       and c.entries_total > (select count(*) from public.punch_card_uses u
                               where u.organization_id = c.organization_id and u.card_id = c.id and u.returned_at is null)
     order by c.expires_on nulls last, c.activated_at, c.id
     limit 1;
    if v_card is not null then
      insert into public.punch_card_uses (organization_id, card_id, meeting_id, used_on)
      values (new.organization_id, v_card, new.id, v_day);
    end if;
  end if;
  return null;
end;
$$;
revoke all on function app.meetings_punch_card_use() from public, anon, authenticated;

create or replace trigger meetings_punch_card_use after insert or update of status on public.meetings
  for each row execute function app.meetings_punch_card_use();

create or replace function app.meetings_punch_card_return() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- the business itself is going away: its cards go too (and the log has nothing to attach an entry to)
  if not app.org_exists(old.organization_id) then
    return old;
  end if;
  update public.punch_card_uses u
     set returned_at = now(), returned_by = auth.uid(), return_kind = 'meeting'
   where u.organization_id = old.organization_id and u.meeting_id = old.id and u.returned_at is null;
  return old;
end;
$$;
revoke all on function app.meetings_punch_card_return() from public, anon, authenticated;

create or replace trigger meetings_punch_card_return before delete on public.meetings
  for each row execute function app.meetings_punch_card_return();

-- ----------------------------------------------------------------------------
-- An authorized person gives a used entry back, with a reason
-- ----------------------------------------------------------------------------
create or replace function public.punch_card_use_return(p_org uuid, p_use uuid, p_reason text) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_contact uuid;
  v_returned timestamptz;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not (coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false) and app.org_writable(p_org)) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select c.contact_id, u.returned_at into v_contact, v_returned
    from public.punch_card_uses u
    join public.punch_cards c on c.organization_id = u.organization_id and c.id = u.card_id
   where u.organization_id = p_org and u.id = p_use
   for update of u;
  if not found or not app.punch_card_contact_ok(p_org, v_contact) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_returned is not null then
    raise exception 'the entry was given back already' using errcode = 'P0001', hint = 'punch_card_use:returned';
  end if;
  if char_length(v_reason) not between 1 and 500 then
    raise exception 'a reason of 1 to 500 characters' using errcode = 'P0001', hint = 'punch_card:reason';
  end if;
  update public.punch_card_uses u
     set returned_at = now(), returned_by = auth.uid(), return_kind = 'manual', return_reason = v_reason
   where u.organization_id = p_org and u.id = p_use;
end;
$$;
revoke all on function public.punch_card_use_return(uuid, uuid, text) from public, anon;
grant execute on function public.punch_card_use_return(uuid, uuid, text) to authenticated;

-- ----------------------------------------------------------------------------
-- Owner (87) ב: the privacy erasure reaches the used entries (app.punch_cards_erase: the body of 021166 plus the entries)
-- ----------------------------------------------------------------------------
-- The used entries of the person's gone cards are found by their entries' card_id and erased with them. On a card the
-- person held before (second review, finding 5): a return reason written while they held it becomes the neutral text and
-- the entries' log entries written then are erased; later ones keep their facts, the person's id replaced. When the
-- history does not say when they held it, every return reason on the card is neutralised and no entry is erased.
create or replace function app.punch_cards_erase(p_org uuid, p_contact uuid, p_children text[]) returns text[]
language plpgsql security definer
set search_path = ''
as $$
declare
  v_card record;
  v_periods tstzrange[];
  v_unknown boolean;
  v_zero constant text := '00000000-0000-0000-0000-000000000000';
  v_gone text[];
  v_more text[] := '{}';
begin
  for v_card in
    select c.id, c.created_at, c.cancelled_at, c.holder_history from public.punch_cards c
     where c.organization_id = p_org and p_contact = any (c.former_contact_ids)
     order by c.id
     for update
  loop
    v_periods := app.punch_card_holder_periods(v_card.created_at, v_card.holder_history, p_contact);
    v_unknown := cardinality(v_periods) = 0;
    update public.punch_cards c
       set cancel_reason = case when c.cancel_reason is not null
                                 and (v_unknown or app.punch_card_in_periods(c.cancelled_at, v_periods))
                                then 'הסיבה נמחקה (מחיקת פרטיות)' else c.cancel_reason end,
           former_contact_ids = array_remove(c.former_contact_ids, p_contact),
           holder_history = (select coalesce(jsonb_agg(case when x.e ->> 'contact' = p_contact::text then x.e - 'contact' else x.e end
                                                       order by x.o), '[]'::jsonb)
                               from jsonb_array_elements(c.holder_history) with ordinality as x(e, o))
     where c.organization_id = p_org and c.id = v_card.id;
    update public.punch_card_uses u set return_reason = 'הנימוק נמחק (מחיקת פרטיות)'
     where u.organization_id = p_org and u.card_id = v_card.id and u.return_reason is not null
       and (v_unknown or app.punch_card_in_periods(u.returned_at, v_periods));
    if not v_unknown then
      update public.audit_log a set changes = '{"erased": true}'::jsonb
       where a.organization_id = p_org and a.action <> 'erase' and a.changes is distinct from '{"erased": true}'::jsonb
         and app.punch_card_in_periods(a.created_at, v_periods)
         and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
              or (a.entity_type = 'punch_card_uses'
                  and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
    end if;
    update public.audit_log a set changes = replace(a.changes::text, p_contact::text, v_zero)::jsonb
     where a.organization_id = p_org and a.action <> 'erase' and strpos(a.changes::text, p_contact::text) > 0
       and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
            or (a.entity_type = 'punch_card_uses'
                and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
    -- the log entries this erasure just wrote keep the old reasons: they go too
    update public.audit_log a set changes = '{"erased": true}'::jsonb
     where a.organization_id = p_org and a.created_at = now() and a.action = 'update'
       and (a.changes ? 'cancel_reason' or a.changes ? 'return_reason')
       and ((a.entity_type = 'punch_cards' and a.entity_id = v_card.id)
            or (a.entity_type = 'punch_card_uses'
                and a.entity_id in (select u.id from public.punch_card_uses u where u.organization_id = p_org and u.card_id = v_card.id)));
  end loop;
  -- the used entries of the person's gone cards (their delete entries carry card_id)
  v_gone := array(select substr(c, length('punch_cards:') + 1) from unnest(p_children) c where c like 'punch_cards:%');
  if cardinality(v_gone) > 0 then
    select coalesce(array_agg(distinct 'punch_card_uses:' || a.entity_id), '{}') into v_more
      from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'punch_card_uses' and a.entity_id is not null
       and coalesce(a.changes ->> 'card_id', a.changes -> 'card_id' ->> 'old') = any (v_gone)
       and not exists (select 1 from public.punch_card_uses u where u.organization_id = p_org and u.id = a.entity_id);
  end if;
  return v_more;
end;
$$;
revoke all on function app.punch_cards_erase(uuid, uuid, text[]) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';

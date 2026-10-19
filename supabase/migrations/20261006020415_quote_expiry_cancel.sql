-- QUO-11: the last two quote statuses get their way in (spec: "draft, sent, viewed, accepted, declined, expired, cancelled;
-- the move to expired is automatic on the validity date").
--
-- * Expiry. pg_cron `crm-quote-expiry` (every 15 minutes) runs app.expire_quotes(): a sent or viewed quote whose valid_until
--   is before the business's today (its time zone, app.intake_zone: the rule of app.quote_link_open, which already closes
--   the customer's page on that day) becomes 'expired'. Fair and batched: at most app.quote_expiry_per_org() per business
--   (200) and app.quote_expiry_limit() per run (2,000), oldest validity first; each quote in its own exception block, a
--   quote that fails waits an hour in app.quote_expiry_retry so it never holds back the rest of its business (marked done
--   when it later expires). Every
--   business is expired, read-only and closed ones too: it is bookkeeping, and their customer pages are closed already.
--   The quote's owner (an active member) gets one notice of the existing kind `quote` (number and title, no amounts).
-- * Cancelling. public.quote_cancel(org, quote) (definer): whoever may edit the quote's deal or contact (app.quote_editable,
--   the rule of every other quote action) in a business with quotes; a sent, viewed or expired quote only. A draft is
--   deleted instead (hint quote_cancel:draft), an accepted quote is refused for now (hint quote_cancel:accepted; an open
--   question for the owner), a declined or cancelled one is closed (hint quote_cancel:closed).
-- * Timeline. QUO-16's trigger writes both as 'system' entries (metadata kinds quote_expired, quote_cancelled): neither is
--   contact with the customer, so neither stamps last contact; created_by stays empty (trigger
--   activities_zz_quote_system_author clears what touch_row sets for a signed-in canceller), and the cancel entry names who
--   cancelled in its body. A person still cannot write either kind (app.activities_quote_entry_guard, unchanged).

-- ----------------------------------------------------------------------------
-- Timeline: the body of 020335 with the two new kinds
-- ----------------------------------------------------------------------------
create or replace function app.quote_timeline_entry() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_kind text;
  v_person uuid := auth.uid();
  v_type text;
  v_by text;
begin
  if new.status is not distinct from old.status or (new.deal_id is null and new.contact_id is null) then
    return null;
  end if;
  v_kind := case new.status
              when 'sent' then 'quote_sent' when 'accepted' then 'quote_accepted' when 'rejected' then 'quote_rejected'
              when 'expired' then 'quote_expired' when 'cancelled' then 'quote_cancelled' end;
  if v_kind is null then
    return null;
  end if;
  -- only "sent" is a person's contact with the customer; everything else is a system entry with no author
  v_type := case when v_kind = 'quote_sent' and v_person is not null then 'note' else 'system' end;
  if v_kind = 'quote_cancelled' and v_person is not null then
    select nullif(btrim(p.full_name), '') into v_by from public.profiles p where p.id = v_person;
  end if;

  insert into public.activities (organization_id, type, deal_id, contact_id, body, metadata, created_by)
  values (new.organization_id, v_type, new.deal_id, new.contact_id,
          'הצעת מחיר' || coalesce(' ' || new.number_display, '')
            || case v_kind when 'quote_sent' then ' נשלחה' when 'quote_accepted' then ' אושרה' when 'quote_rejected' then ' נדחתה'
                           when 'quote_expired' then ' פג תוקפה' else ' בוטלה' end
            || coalesce(' על ידי ' || left(v_by, 120), ''),
          jsonb_build_object('kind', v_kind, 'quote_id', new.id, 'number', new.number_display),
          case when v_type = 'note' then v_person end);
  return null;
end;
$$;
revoke all on function app.quote_timeline_entry() from public, anon, authenticated, service_role;

-- A quote's system entry has no author, even when a signed-in person's cancel wrote it: touch_row sets created_by to the
-- session's user on every insert, and the reports that count a person's activity (created_by is not null) would count a
-- cancellation as work on the deal. Like activities_zz_automation_note, this runs after activities_touch (name order) and
-- clears it. A person cannot write such an entry at all (app.activities_quote_entry_guard), so only the server's pass here.
create or replace function app.activities_quote_system_author() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_by := null;
  return new;
end;
$$;
revoke all on function app.activities_quote_system_author() from public, anon, authenticated, service_role;

create or replace trigger activities_zz_quote_system_author before insert on public.activities
  for each row when (new.type = 'system' and coalesce(new.metadata ->> 'kind', '') like 'quote\_%')
  execute function app.activities_quote_system_author();

-- ----------------------------------------------------------------------------
-- Cancelling
-- ----------------------------------------------------------------------------
create or replace function public.quote_cancel(p_org uuid, p_quote uuid) returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  v_quote public.quotes;
begin
  select * into v_quote from public.quotes q where q.organization_id = p_org and q.id = p_quote for update;
  if not found or not app.quote_editable(p_org, v_quote.deal_id, v_quote.contact_id) then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if not app.org_has_feature(p_org, 'quotes') then
    raise exception 'quotes are not in this plan' using errcode = 'P0001', hint = 'feature:quotes';
  end if;
  if v_quote.status = 'draft' then
    raise exception 'a draft is deleted, not cancelled' using errcode = 'P0001', hint = 'quote_cancel:draft';
  end if;
  if v_quote.status = 'accepted' then
    raise exception 'an accepted quote cannot be cancelled' using errcode = 'P0001', hint = 'quote_cancel:accepted';
  end if;
  if v_quote.status not in ('sent', 'viewed', 'expired') then
    raise exception 'the quote is already closed' using errcode = 'P0001', hint = 'quote_cancel:closed';
  end if;
  update public.quotes q set status = 'cancelled' where q.organization_id = p_org and q.id = p_quote;
end;
$$;
revoke all on function public.quote_cancel(uuid, uuid) from public, anon;
grant execute on function public.quote_cancel(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- Expiry
-- ----------------------------------------------------------------------------
-- the open quotes by validity date, for the job's scan
create index if not exists quotes_open_valid_until_idx on public.quotes (valid_until, organization_id)
  where status in ('sent', 'viewed') and valid_until is not null;

-- a quote whose expiry failed waits here before it is tried again (ids only; no API access). A later success marks the
-- row done instead of deleting it (no delete in a connector migration); at most one row per quote that ever failed.
create table if not exists app.quote_expiry_retry (
  quote_id   uuid primary key,
  retry_at   timestamptz not null,
  done_at    timestamptz
);
alter table app.quote_expiry_retry enable row level security;
revoke all on app.quote_expiry_retry from public, anon, authenticated, service_role;

create or replace function app.quote_expiry_per_org() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,5}$' then least(greatest(s::int, 1), 200) else 200 end
    from coalesce(current_setting('app.quote_expiry_per_org', true), '') as s;
$$;
revoke all on function app.quote_expiry_per_org() from public, anon, authenticated;

create or replace function app.quote_expiry_limit() returns integer
language sql stable
set search_path = ''
as $$
  select case when s ~ '^[0-9]{1,5}$' then least(greatest(s::int, 1), 2000) else 2000 end
    from coalesce(current_setting('app.quote_expiry_limit', true), '') as s;
$$;
revoke all on function app.quote_expiry_limit() from public, anon, authenticated;

create or replace function app.expire_quotes() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_quote public.quotes;
  v_done integer := 0;
begin
  for v_row in
    select d.organization_id, d.id
      from (
        select q.organization_id, q.id, q.valid_until,
               row_number() over (partition by q.organization_id order by q.valid_until, q.id) as n
          from public.quotes q
          join public.organizations o on o.id = q.organization_id
         where q.status in ('sent', 'viewed')
           and q.valid_until is not null
           and q.valid_until < (now() at time zone app.intake_zone(o.timezone))::date
           and not exists (select 1 from app.quote_expiry_retry r where r.quote_id = q.id and r.done_at is null and r.retry_at > now())
      ) d
     where d.n <= app.quote_expiry_per_org()
     order by d.valid_until, d.id
     limit app.quote_expiry_limit()
  loop
    begin
      -- a quote being decided or cancelled right now is left for the next run
      select * into v_quote from public.quotes q
       where q.organization_id = v_row.organization_id and q.id = v_row.id and q.status in ('sent', 'viewed')
       for update skip locked;
      if found then
        update public.quotes q set status = 'expired' where q.organization_id = v_quote.organization_id and q.id = v_quote.id;
        insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
        select v_quote.organization_id, v_quote.owner_id, 'quote', left('פג תוקפה של הצעת מחיר: ' || v_quote.title, 200),
               case when v_quote.number_display is not null then 'הצעה ' || v_quote.number_display end, 'quote', v_quote.id
         where v_quote.owner_id is not null
           and exists (select 1 from public.memberships m
                        where m.organization_id = v_quote.organization_id and m.user_id = v_quote.owner_id and m.status = 'active');
        update app.quote_expiry_retry r set done_at = now() where r.quote_id = v_quote.id and r.done_at is null;
        v_done := v_done + 1;
      end if;
    exception when others then
      -- this quote's changes are rolled back; it waits an hour, the others go on
      insert into app.quote_expiry_retry (quote_id, retry_at) values (v_row.id, now() + interval '1 hour')
      on conflict (quote_id) do update set retry_at = excluded.retry_at, done_at = null;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.expire_quotes() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-quote-expiry', '*/15 * * * *', 'select app.expire_quotes();');
  end if;
end;
$$;

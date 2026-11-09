-- QUO-06 / PKG-06 follow-up, owner's answer (175) ג (9 November 2026): every quote that is SENT keeps its state as sent, so a
-- PDF as sent that is made again later (the recipient-erasure remake of 021187, or any other remake path) renders exactly what
-- was sent: each optional line's selection and the amounts the PDF prints (lines' sum, document discount, before VAT, VAT,
-- total; the payment schedule's amounts follow the total). It applies only to quotes sent after this migration: older quotes
-- have no snapshot and keep 021187's rule (an accepted quote whose choice changed is rendered as accepted, "לפי מה שאושר").
-- It never changes the signed PDF (QUO-09).
--
-- What acceptance can change on a sent quote (021117): quote_public_answer writes the customer's choice into the lines'
-- optional_selected, and app.quotes_check works the five totals out again at the frozen rate. Everything else the PDF as sent
-- prints from the quote is frozen at sending already (lines and their prices, rate, bank details 021087, recipient names
-- 021185). So the snapshot holds exactly those: the rate and five totals, and the optional item lines' ids with their
-- selection. No free text, no names: nothing personal, so erasure has nothing to clear in it.
--
-- app.quote_sent_states   one row per sent quote, in schema app (RLS on, no policies, no grants), so neither PostgREST nor any
--                         public read returns it (public.quotes has a table-level select grant: a column there would be read by
--                         every reader of the quote, and audit_row would log it). Written only by the definer trigger
--                         quotes_sent_state when a quote leaves draft (quote_send), once (on conflict do nothing; a sent
--                         quote never returns to draft, quote:no_redraft); frozen for every writer (trigger
--                         quote_sent_states_frozen refuses any update, hint quote_sent_state:frozen); cascades with the quote
--                         and the business. Versions, duplicates and addenda are new drafts: each gets its own snapshot when it
--                         is itself sent, never a copy.
-- public.quote_sent_state(org, quote)   INVOKER, the person's session: the quote must be one the caller reads (RLS on
--                         quotes), not a draft; the definer helper app.quote_sent_state_of answers only to a writer
--                         (app.can_write) of a writable business (app.org_writable) with the quotes key, who may edit the
--                         quote's deal or contact (app.quote_editable): the rule of quote_pdf_allowed and
--                         quote_pdf_recipient_remake_allowed without their status and credit parts. Null when there is no
--                         snapshot (a quote sent before this migration) or for anyone else.
--
-- No existing function is redefined. Every statement is safe to run twice. No drops, no row removal.

create table if not exists app.quote_sent_states (
  organization_id       uuid not null,
  quote_id              uuid not null,
  taken_at              timestamptz not null default now(),
  vat_rate_bp           integer,
  subtotal_agorot       bigint not null,
  discount_total_agorot bigint not null,
  net_total_agorot      bigint not null,
  vat_agorot            bigint not null,
  total_agorot          bigint not null,
  -- [{"id": <quote line id>, "selected": <boolean>}] for the quote's optional item lines, by position then id
  optional_lines        jsonb not null default '[]'::jsonb,
  primary key (organization_id, quote_id),
  constraint quote_sent_states_quote_fk foreign key (organization_id, quote_id)
    references public.quotes (organization_id, id) on delete cascade,
  constraint quote_sent_states_optional_shape check (jsonb_typeof(optional_lines) = 'array')
);
comment on table app.quote_sent_states is
  'Owner (175) ג: a quote''s state as sent (rate, totals, optional selections; no text), taken once when it left draft.';
alter table app.quote_sent_states enable row level security;
revoke all on table app.quote_sent_states from public, anon, authenticated, service_role;

-- frozen for every writer, the definer functions included
create or replace function app.quote_sent_states_frozen() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a quote''s state as sent never changes' using errcode = 'P0001', hint = 'quote_sent_state:frozen';
end;
$$;
revoke all on function app.quote_sent_states_frozen() from public, anon, authenticated, service_role;

create or replace trigger quote_sent_states_frozen before update on app.quote_sent_states
  for each row execute function app.quote_sent_states_frozen();

-- The snapshot, taken AFTER the row is written, so it reads the totals app.quotes_check stored and the lines as they are at
-- that moment (a sent quote's lines are frozen; only acceptance moves optional_selected later).
create or replace function app.quotes_sent_state() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  insert into app.quote_sent_states (organization_id, quote_id, vat_rate_bp, subtotal_agorot, discount_total_agorot,
                                     net_total_agorot, vat_agorot, total_agorot, optional_lines)
  values (new.organization_id, new.id, new.vat_rate_bp, new.subtotal_agorot, new.discount_total_agorot,
          new.net_total_agorot, new.vat_agorot, new.total_agorot,
          coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'selected', l.optional_selected) order by l.position, l.id)
                      from public.quote_lines l
                     where l.organization_id = new.organization_id and l.quote_id = new.id
                       and l.kind = 'item' and l.is_optional), '[]'::jsonb))
  on conflict (organization_id, quote_id) do nothing;
  return null;
end;
$$;
revoke all on function app.quotes_sent_state() from public, anon, authenticated, service_role;

create or replace trigger quotes_sent_state after update of status on public.quotes
  for each row when (old.status = 'draft' and new.status <> 'draft')
  execute function app.quotes_sent_state();
-- No insert trigger: app.quotes_check makes every new quote a draft, so a quote is sent only by the update above (review L1).

-- The snapshot for the people who may have the quote's PDF made. Definer (app tables have no grants); the public invoker
-- wrapper below asks it only about a quote the caller reads.
create or replace function app.quote_sent_state_of(p_org uuid, p_quote uuid) returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
           'vat_rate_bp', s.vat_rate_bp,
           'subtotal_agorot', s.subtotal_agorot,
           'discount_total_agorot', s.discount_total_agorot,
           'net_total_agorot', s.net_total_agorot,
           'vat_agorot', s.vat_agorot,
           'total_agorot', s.total_agorot,
           'optional_lines', s.optional_lines)
    from app.quote_sent_states s
    join public.quotes q on q.organization_id = s.organization_id and q.id = s.quote_id
   where s.organization_id = p_org and s.quote_id = p_quote
     and app.can_write(p_org)
     and app.org_writable(p_org)
     and app.org_has_feature(p_org, 'quotes')
     and app.quote_editable(q.organization_id, q.deal_id, q.contact_id)
$$;
revoke all on function app.quote_sent_state_of(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.quote_sent_state_of(uuid, uuid) to authenticated;

create or replace function public.quote_sent_state(p_org uuid, p_quote uuid) returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select app.quote_sent_state_of(q.organization_id, q.id)
    from public.quotes q
   where q.organization_id = p_org and q.id = p_quote and q.status <> 'draft'
$$;
revoke all on function public.quote_sent_state(uuid, uuid) from public, anon;
grant execute on function public.quote_sent_state(uuid, uuid) to authenticated;

-- Whether a quote the caller reads has its state as sent (a boolean, no amounts): the staff page names the PDF as sent made
-- again by what it shows ("כפי שנשלח" when it came from the snapshot, 021187's "כפי שאושר" only for a quote without one).
create or replace function app.quote_sent_state_exists(p_org uuid, p_quote uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select app.is_member(p_org)
     and exists (select 1 from app.quote_sent_states s where s.organization_id = p_org and s.quote_id = p_quote)
$$;
revoke all on function app.quote_sent_state_exists(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function app.quote_sent_state_exists(uuid, uuid) to authenticated;

create or replace function public.quote_has_sent_state(p_org uuid, p_quote uuid) returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = p_quote)
     and app.quote_sent_state_exists(p_org, p_quote)
$$;
revoke all on function public.quote_has_sent_state(uuid, uuid) from public, anon;
grant execute on function public.quote_has_sent_state(uuid, uuid) to authenticated;

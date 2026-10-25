-- =============================================================================
-- PAY-04: cheques (owner, 21 October 2026, DECISIONS.md "צ'קים"; the lead's calls of 25 October 2026: kind 'payment' for the
-- reminder, the bank list below, a series of at most 36)
-- =============================================================================
-- * Each cheque is its own payment (answer 1; a series is N payments made by one insert in the app). Nullable columns on
--   public.payments: cheque_number (digits), cheque_bank (a Bank of Israel bank code from app.cheque_bank_codes(), or
--   'other' for a foreign bank with cheque_bank_name), cheque_branch (3 digits; may stay empty only with 'other'),
--   cheque_due_date (the day it may be cashed), cheque_status (in_hand | deposited | cleared | bounced) and
--   cheque_unbounce_reason (why a bounced cheque was taken back). Constraint payments_cheque_shape: no cheque field on any
--   other method; a cheque with a status has a bank and a due date. A cheque payment recorded before PAY-04 has no fields.
-- * Definer trigger app.payments_cheque (payments_a_cheque, named to run before payments_check, which is unchanged; outsider
--   guard first) holds the rules for a person's write:
--     - a new cheque payment carries number, bank, branch (unless 'other') or the foreign bank's name, due date and
--       status (cheque:fields); the bank comes from the list (cheque:bank), the branch is 3 digits (cheque:branch);
--     - the cheque's status sets the payment's (answer 2): in_hand / deposited = recorded, cleared = confirmed,
--       bounced = failed (the debt is open again; PAY-02 releases its allocations when that lands). Setting recorded,
--       confirmed or failed on such a payment directly is refused (cheque:status); cancelled and refunded follow
--       payments_check;
--     - whoever records payments moves the cheque's status (answer 3); its details are a correction, for owners and
--       admins (payment:correction);
--     - a bounced cheque leaves "bounced" only by an owner or admin, with a reason (answer 4: cheque:bounced,
--       cheque:reason), kept in cheque_unbounce_reason and in the payment's audit entry.
--     - a cancelled payment's cheque never changes (payment:cancelled), nor a refunded one's (cheque:refunded), for every
--       writer.
--   Server writes pass only while the cheque is untouched (the FK set-null, a merge), or while an erasure only empties
--   the number, a foreign bank's name and the unbounce reason.
-- * payments_emit_confirmed (PAY-07, 020780) becomes plain "after insert or update": a write naming only cheque_status
--   moves the payment's status through this trigger, and "update of status" would not fire for it. The function
--   app.emit_payment_confirmed is unchanged (recorded -> confirmed only).
-- * Reminder on the due date (answer 6): pg_cron crm-cheque-reminders (every 15 minutes) runs app.send_cheque_reminders():
--   cheques in hand or deposited whose due date is today in the business's zone, from 08:00 there, of a writable business;
--   one notice of kind 'payment' to the recorder while an active member who is not a viewer, else to the active owners and
--   admins; the cheque's number and amount, no name; once per cheque and day (app.cheque_reminders_sent); 200 per business
--   and 2,000 per run, each cheque in its own exception block.
-- * Privacy erasure (app.audit_erase_core, the body of 020750): a payment the erasure reaches also loses its cheque number,
--   a foreign bank's name and the unbounce reason (bank code, branch, date and status stay), and its due-date reminders
--   lose the number (body "צ'ק · <amount>").
-- Every statement is safe to run twice. No drops of data, no row removal.

-- Bank of Israel bank codes (the two-digit bank numbers of the Bank of Israel's list of banks in Israel); mirrored by
-- ISRAELI_BANKS in src/features/payments/cheques.ts (unit test)
create or replace function app.cheque_bank_codes() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['04', '09', '10', '11', '12', '13', '14', '17', '18', '20', '22', '23', '26', '31', '34', '46', '52', '54']::text[]
$$;
revoke all on function app.cheque_bank_codes() from public, anon, authenticated, service_role;

alter table public.payments add column if not exists cheque_number text;
alter table public.payments add column if not exists cheque_bank text;
alter table public.payments add column if not exists cheque_bank_name text;
alter table public.payments add column if not exists cheque_branch text;
alter table public.payments add column if not exists cheque_due_date date;
alter table public.payments add column if not exists cheque_status text;
alter table public.payments add column if not exists cheque_unbounce_reason text;

alter table public.payments drop constraint if exists payments_cheque_values;
alter table public.payments add constraint payments_cheque_values check (
  (cheque_number is null or cheque_number ~ '^[0-9]{1,20}$')
  and (cheque_bank is null or cheque_bank ~ '^([0-9]{2}|other)$')
  and (cheque_bank_name is null or char_length(cheque_bank_name) between 1 and 80)
  and (cheque_branch is null or cheque_branch ~ '^[0-9]{3}$')
  and (cheque_status is null or cheque_status in ('in_hand', 'deposited', 'cleared', 'bounced'))
  and (cheque_unbounce_reason is null or char_length(btrim(cheque_unbounce_reason)) between 1 and 500));
alter table public.payments drop constraint if exists payments_cheque_shape;
alter table public.payments add constraint payments_cheque_shape check (
  (method <> 'cheque'
   and num_nonnulls(cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status, cheque_unbounce_reason) = 0)
  or (method = 'cheque'
      and (cheque_status is null
           or (cheque_bank is not null and cheque_due_date is not null
               and (cheque_bank = 'other' or cheque_branch is not null)
               and (cheque_bank = 'other' or cheque_bank_name is null)))));

create index if not exists payments_cheque_due_idx on public.payments (organization_id, cheque_due_date)
  where cheque_status in ('in_hand', 'deposited');

grant insert (cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status) on public.payments to authenticated;
grant update (cheque_number, cheque_bank, cheque_bank_name, cheque_branch, cheque_due_date, cheque_status, cheque_unbounce_reason)
  on public.payments to authenticated;

-- the payment status a cheque status means (answer 2)
create or replace function app.cheque_payment_status(p_cheque text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_cheque when 'in_hand' then 'recorded' when 'deposited' then 'recorded'
                       when 'cleared' then 'confirmed' when 'bounced' then 'failed' end
$$;
revoke all on function app.cheque_payment_status(text) from public, anon, authenticated, service_role;

create or replace function app.payments_cheque() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_details_changed boolean;
  v_cheque_same boolean;
begin
  -- outsider guard: RLS refuses (42501) a person who may not record payments here
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  -- server writes pass only while they leave the cheque alone: the FK set-null (a nested trigger) and a merge change no
  -- cheque column; an erasure only empties the number, a foreign bank's name and the unbounce reason
  if tg_op = 'UPDATE' then
    v_cheque_same := row(new.cheque_number, new.cheque_bank, new.cheque_bank_name, new.cheque_branch, new.cheque_due_date,
                         new.cheque_status, new.cheque_unbounce_reason)
                     is not distinct from
                     row(old.cheque_number, old.cheque_bank, old.cheque_bank_name, old.cheque_branch, old.cheque_due_date,
                         old.cheque_status, old.cheque_unbounce_reason);
    if (pg_trigger_depth() > 1 or coalesce(current_setting('app.payment_server', true), '') = 'on') and v_cheque_same then
      return new;
    end if;
    if coalesce(current_setting('app.payment_server', true), '') = 'erase'
       and row(new.cheque_bank, new.cheque_branch, new.cheque_due_date, new.cheque_status)
           is not distinct from row(old.cheque_bank, old.cheque_branch, old.cheque_due_date, old.cheque_status)
       and (new.cheque_number is null or new.cheque_number is not distinct from old.cheque_number)
       and (new.cheque_bank_name is null or new.cheque_bank_name is not distinct from old.cheque_bank_name)
       and (new.cheque_unbounce_reason is null or new.cheque_unbounce_reason is not distinct from old.cheque_unbounce_reason) then
      return new;
    end if;
    -- a cancelled or refunded payment keeps its cheque as it is, for every writer
    if old.status in ('cancelled', 'refunded') and not v_cheque_same then
      if old.status = 'cancelled' then
        raise exception 'a cancelled payment does not change' using errcode = 'P0001', hint = 'payment:cancelled';
      end if;
      raise exception 'the cheque of a refunded payment does not change' using errcode = 'P0001', hint = 'cheque:refunded';
    end if;
  end if;

  new.cheque_number := nullif(btrim(coalesce(new.cheque_number, '')), '');
  new.cheque_bank_name := nullif(btrim(coalesce(new.cheque_bank_name, '')), '');
  new.cheque_branch := nullif(btrim(coalesce(new.cheque_branch, '')), '');

  if new.method = 'cheque' and (tg_op = 'INSERT' or old.method is distinct from 'cheque' or new.cheque_status is not null
                                 or old.cheque_status is not null) then
    -- a person's cheque carries its details
    if auth.uid() is not null
       and (new.cheque_number is null or new.cheque_bank is null or new.cheque_due_date is null or new.cheque_status is null
            or (new.cheque_bank = 'other' and new.cheque_bank_name is null)
            or (new.cheque_bank <> 'other' and new.cheque_branch is null)) then
      raise exception 'a cheque needs its number, bank, branch, due date and status' using errcode = 'P0001', hint = 'cheque:fields';
    end if;
    if new.cheque_bank is not null and new.cheque_bank <> 'other' and not (new.cheque_bank = any (app.cheque_bank_codes())) then
      raise exception 'the bank is not on the list' using errcode = 'P0001', hint = 'cheque:bank';
    end if;
    if new.cheque_bank is not null and new.cheque_bank <> 'other' then
      new.cheque_bank_name := null;
    end if;
    if new.cheque_branch is not null and new.cheque_branch !~ '^[0-9]{3}$' then
      raise exception 'a branch is 3 digits' using errcode = 'P0001', hint = 'cheque:branch';
    end if;
  end if;

  if tg_op = 'INSERT' then
    new.cheque_unbounce_reason := null;
    if new.method = 'cheque' and new.cheque_status is not null then
      new.status := app.cheque_payment_status(new.cheque_status);
    end if;
    return new;
  end if;

  -- UPDATE by a person (or a server function in the person's name)
  if old.status in ('cancelled', 'refunded') then
    return new;  -- the cheque is unchanged (above); payments_check judges the rest
  end if;
  v_details_changed := row(new.cheque_number, new.cheque_bank, new.cheque_bank_name, new.cheque_branch, new.cheque_due_date)
                       is distinct from row(old.cheque_number, old.cheque_bank, old.cheque_bank_name, old.cheque_branch, old.cheque_due_date);
  if v_details_changed and auth.uid() is not null and not app.is_admin(new.organization_id) then
    raise exception 'only owners and admins correct a cheque' using errcode = 'P0001', hint = 'payment:correction';
  end if;

  if new.cheque_status is distinct from old.cheque_status then
    if old.cheque_status = 'bounced' then
      -- answer 4: back from "bounced" by an owner or admin only, with a reason
      if auth.uid() is not null and not app.is_admin(new.organization_id) then
        raise exception 'only owners and admins take a cheque back from bounced' using errcode = 'P0001', hint = 'cheque:bounced';
      end if;
      new.cheque_unbounce_reason := nullif(btrim(coalesce(new.cheque_unbounce_reason, '')), '');
      if new.cheque_unbounce_reason is null or new.cheque_unbounce_reason is not distinct from old.cheque_unbounce_reason
         or char_length(new.cheque_unbounce_reason) > 500 then
        raise exception 'say why the cheque is taken back' using errcode = 'P0001', hint = 'cheque:reason';
      end if;
    elsif new.cheque_unbounce_reason is distinct from old.cheque_unbounce_reason then
      raise exception 'a reason goes with taking a cheque back from bounced' using errcode = 'P0001', hint = 'cheque:reason';
    end if;
    if new.cheque_status is not null and new.status not in ('cancelled', 'refunded') then
      new.status := app.cheque_payment_status(new.cheque_status);
    end if;
    return new;
  end if;

  if new.cheque_unbounce_reason is distinct from old.cheque_unbounce_reason then
    raise exception 'a reason goes with taking a cheque back from bounced' using errcode = 'P0001', hint = 'cheque:reason';
  end if;
  -- the status of a cheque payment follows its cheque
  if new.method = 'cheque' and new.cheque_status is not null and new.status is distinct from old.status
     and new.status in ('recorded', 'confirmed', 'failed') and new.status <> app.cheque_payment_status(new.cheque_status) then
    raise exception 'a cheque payment''s status follows the cheque' using errcode = 'P0001', hint = 'cheque:status';
  end if;
  return new;
end;
$$;
revoke all on function app.payments_cheque() from public, anon, authenticated, service_role;

create or replace trigger payments_a_cheque before insert or update on public.payments
  for each row execute function app.payments_cheque();

-- a cheque_status-only write changes the status through payments_a_cheque, which "update of status" misses
create or replace trigger payments_emit_confirmed after insert or update on public.payments
  for each row when (new.status = 'confirmed') execute function app.emit_payment_confirmed();

-- ----------------------------------------------------------------------------
-- The reminder on the due date (answer 6)
-- ----------------------------------------------------------------------------
create table if not exists app.cheque_reminders_sent (
  payment_id  uuid not null references public.payments (id) on delete cascade,
  due_date    date not null,
  sent_at     timestamptz not null default now(),
  primary key (payment_id, due_date)
);
alter table app.cheque_reminders_sent enable row level security;
revoke all on app.cheque_reminders_sent from public, anon, authenticated, service_role;

create or replace function app.cheque_reminder_per_org() returns integer language sql immutable set search_path = '' as $$ select 200 $$;
create or replace function app.cheque_reminder_limit() returns integer language sql immutable set search_path = '' as $$ select 2000 $$;
revoke all on function app.cheque_reminder_per_org() from public, anon, authenticated, service_role;
revoke all on function app.cheque_reminder_limit() from public, anon, authenticated, service_role;

create or replace function app.send_cheque_reminders() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_done integer := 0;
begin
  for v_row in
    select d.* from (
      select p.organization_id, p.id, p.cheque_number, p.cheque_due_date, p.amount_agorot, p.created_by, p.deal_id, p.contact_id,
             row_number() over (partition by p.organization_id order by p.id) as n
        from public.payments p
        join public.organizations o on o.id = p.organization_id
       where p.cheque_status in ('in_hand', 'deposited')
         and p.status in ('recorded', 'confirmed')
         and p.cheque_due_date = (now() at time zone app.intake_zone(o.timezone))::date
         and (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00'
         and app.org_writable(p.organization_id)
         and not exists (select 1 from app.cheque_reminders_sent s where s.payment_id = p.id and s.due_date = p.cheque_due_date)
    ) d
     where d.n <= app.cheque_reminder_per_org()
     order by d.organization_id, d.id
     limit app.cheque_reminder_limit()
  loop
    begin
      insert into app.cheque_reminders_sent (payment_id, due_date) values (v_row.id, v_row.cheque_due_date);
      insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
      select v_row.organization_id, r.user_id, 'payment', 'צ''ק לפירעון היום',
             'צ''ק ' || coalesce(v_row.cheque_number, '') || ' · ' || app.payment_amount_text(v_row.amount_agorot),
             case when v_row.deal_id is not null then 'deal' when v_row.contact_id is not null then 'contact' end,
             coalesce(v_row.deal_id, v_row.contact_id)
        from (
          select m.user_id from public.memberships m
           where m.organization_id = v_row.organization_id and m.user_id = v_row.created_by
             and m.status = 'active' and m.role <> 'viewer'
          union
          select m.user_id from public.memberships m
           where m.organization_id = v_row.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
             and not exists (select 1 from public.memberships r
                              where r.organization_id = v_row.organization_id and r.user_id = v_row.created_by
                                and r.status = 'active' and r.role <> 'viewer')
        ) r;
      v_done := v_done + 1;
    exception when others then
      -- this cheque's notice is rolled back; the next run tries again
      null;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_cheque_reminders() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-cheque-reminders', '*/15 * * * *', 'select app.send_cheque_reminders();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- Privacy erasure: 020750's app.audit_erase_core, plus a payment's cheque number, foreign bank name and unbounce reason
-- ----------------------------------------------------------------------------
create or replace function app.audit_erase_core(p_org uuid, p_type text, p_id uuid, p_actor uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := case p_type when 'leads' then 'lead_id' when 'contacts' then 'contact_id'
                            when 'companies' then 'company_id' when 'deals' then 'deal_id' end;
  v_exists boolean;
  v_row jsonb;
  v_child record;
  v_children text[] := '{}';
  v_count integer;
  v_more integer;
  -- RVW-45: the deals that were the contact's when it was purged
  v_deals uuid[] := '{}';
  v_payments uuid[] := '{}';
begin
  if v_col is null then
    raise exception 'unknown record type' using errcode = '22023';
  end if;
  execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', p_type)
    into v_exists using p_org, p_id;
  if v_exists then
    raise exception 'delete the record permanently first' using errcode = 'P0001', hint = 'erase:exists';
  end if;

  -- the deleted row, for the form submissions below (before it is erased)
  select a.changes into v_row from public.audit_log a
   where a.organization_id = p_org and a.entity_type = p_type and a.entity_id = p_id and a.action = 'delete'
   order by a.id desc limit 1;

  -- tasks, files, notes and deal lines (DLI-01) that were linked to it and no longer exist: by the
  -- ids in their entries, and for notes by every record they were ever linked to
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders', 'accounting_documents', 'payments', 'customer_holds') and a.entity_id is not null
       and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text or a.changes -> v_col ->> 'new' = p_id::text)
    union
    select 'activities', l.activity_id from app.activity_audit_links l
     where l.organization_id = p_org and l.record_id = p_id
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-01: the lines of those quotes (their entries carry quote_id, not the record's id); GAP-09: and their payment schedule
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('quote_lines', 'quote_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'quote_id', a.changes -> 'quote_id' ->> 'old') = any (
             select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- QUO-07: a sent quote that was detached from the record keeps its number, date and amounts; its
  -- personal details are emptied, and its own entries are erased below with the rest. A draft that
  -- only named the record (a deal's quote naming a purged contact) is the deal's and is left alone.
  if p_type in ('contacts', 'deals') then
    for v_child in
      update public.quotes q
         set customer_name = null, customer_contact_name = null, notes = null, title = 'הצעת מחיר',
             -- QUO-11: the reason staff wrote when cancelling an accepted quote may name the customer
             cancel_reason = null
       where q.organization_id = p_org and q.status <> 'draft'
         and ((p_type = 'contacts' and q.former_contact_id = p_id) or (p_type = 'deals' and q.former_deal_id = p_id))
      returning 'quotes'::text as entity_type, q.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- owner, 18 October 2026 (QUO-07): the free text of those quotes' lines goes too: quantity, price and amounts stay;
    -- a free line and a group heading get a neutral name; every description is emptied. Owner, 19 October 2026: a
    -- product line's name that was edited by hand goes too. "Edited by hand" in the data = the stored name differs
    -- (trimmed) from the product's current catalog name; such a line takes the catalog name (not personal), and a
    -- product that is gone leaves the neutral name. A product line still named as in the catalog keeps it. Payment
    -- steps, milestones and terms stay (owner). These lines' entries (the old text included) are erased below.
    for v_child in
      update public.quote_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
         and exists (select 1 from public.quotes q where q.organization_id = p_org and q.id = l.quote_id and q.status <> 'draft')
      returning 'quote_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-11: the cancel entry of those quotes on the timeline loses its " · סיבה: …" part (the rest is number and author);
    -- the entries' audit history (the old body included) is erased below with the rest
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'quote_cancelled'
         and ac.metadata ->> 'quote_id' = any (select substr(c, length('quotes:') + 1) from unnest(v_children) c where c like 'quotes:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- QUO-09 (owner, 18 October 2026): the customer's decision on those quotes keeps what, when and the fingerprint of the
    -- version; the signer's name, ID, signature, IP, browser and reason go (the table is not audited)
    update public.quote_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.quote_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%');
    -- RVW-42: the notices about those quotes: the title (it may name the customer) becomes "הצעת מחיר" after the notice's own
    -- words, the cancel reason leaves the body, and a "viewed" notice's body (the quote's title) is emptied
    update public.notifications n
       set title = case when n.type = 'quote' and n.title like '%: %'
                        then left(n.title, strpos(n.title, ': ') + 1) || 'הצעת מחיר' else n.title end,
           body = case when n.type = 'quote_viewed' then null
                       else nullif(regexp_replace(n.body, '( · )?סיבה: .*$', ''), '') end
     where n.organization_id = p_org and n.entity_type = 'quote'
       and n.entity_id = any (select substr(c, length('quotes:') + 1)::uuid from unnest(v_children) c where c like 'quotes:%')
       and (n.type = 'quote_viewed' or (n.type = 'quote' and (n.title like '%: %' or n.body like '%סיבה: %')));
  end if;

  -- ORD-01: an order that was detached from the record keeps its number, date, lines' amounts and totals; the customer's
  -- name, the shipping address and the notes go, and its lines' free text goes as for quotes (a product line takes the
  -- catalog name, a free line and a heading a neutral one, every description is emptied). A draft only loses the
  -- shipping address and the name it may have copied from the record. Its entries are erased below with the rest.
  if p_type in ('contacts', 'companies', 'deals') then
    perform set_config('app.order_server', 'on', true);
    for v_child in
      update public.orders o
         set customer_name = case when o.status <> 'draft' then null else o.customer_name end,
             shipping_address = null,
             notes = case when o.status <> 'draft' then null else o.notes end
       where o.organization_id = p_org
         and ((p_type = 'contacts' and o.former_contact_id = p_id) or (p_type = 'deals' and o.former_deal_id = p_id)
              or (p_type = 'companies' and o.former_company_id = p_id))
      returning 'orders'::text as entity_type, o.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    -- ORD-05: the customer's answer on those orders keeps what, when and the fingerprint of what was shown; the signer's
    -- name, ID, signature, IP, browser and reason go (the table is not audited), as for quotes (QUO-09)
    update public.order_decisions d
       set signer_name = null, signer_id_number = null, signature_image = null, ip = null, user_agent = null,
           decline_reason = null, erased_at = coalesce(d.erased_at, now())
     where d.organization_id = p_org
       and d.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%');
    -- ORD-05b: the customer's decline reason goes from the timeline entry (its audit history is erased below) and from the notices
    for v_child in
      update public.activities ac
         set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
       where ac.organization_id = p_org and ac.metadata ->> 'kind' = 'order_answer_rejected'
         and ac.metadata ->> 'order_id' = any (select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
         and ac.body like '% · סיבה: %'
      returning 'activities'::text as entity_type, ac.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    update public.notifications n
       set body = nullif(regexp_replace(n.body, '( · )?סיבה: .*$', ''), '')
     where n.organization_id = p_org and n.entity_type = 'order'
       and n.entity_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
       and n.body like '%סיבה: %';
    for v_child in
      update public.order_lines l
         set description = null,
             name = case
                      when l.kind = 'group' then 'קבוצה'
                      when l.product_id is null then 'שורה'
                      else coalesce((select p.name from public.products p
                                      where p.organization_id = l.organization_id and p.id = l.product_id), 'שורה')
                    end
       where l.organization_id = p_org
         and l.order_id = any (select substr(c, length('orders:') + 1)::uuid from unnest(v_children) c where c like 'orders:%')
         and exists (select 1 from public.orders o where o.organization_id = p_org and o.id = l.order_id and o.status <> 'draft')
      returning 'order_lines'::text as entity_type, l.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.order_server', '', true);
  end if;
  -- DOC-01: a document that was ever on the record (by its entries, within the business) keeps its type, number, date, amount
  -- and state; a cancel reason (staff may have named the customer) becomes a neutral text; its entries are erased below
  -- RVW-45: a contact's deals at its purge, by the FK set-null entry on each deal (contact_id {old: <contact>, new: null})
  if p_type = 'contacts' then
    select coalesce(array_agg(distinct a.entity_id), '{}') into v_deals
      from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'deals' and a.action = 'update' and a.entity_id is not null
       and a.changes -> 'contact_id' ->> 'old' = p_id::text and a.changes -> 'contact_id' ->> 'new' is null;
  end if;
  if p_type in ('contacts', 'deals') then
    for v_child in
      select 'accounting_documents'::text as entity_type, d.id as entity_id
        from public.accounting_documents d
       where d.organization_id = p_org
         and d.id in (select a.entity_id from public.audit_log a
                       where a.organization_id = p_org and a.entity_type = 'accounting_documents' and a.entity_id is not null
                         and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                              or a.changes -> v_col ->> 'new' = p_id::text))
       union
       -- RVW-45: recorded on such a deal without a contact
       select 'accounting_documents'::text, d.id
         from public.accounting_documents d
        where d.organization_id = p_org and d.contact_id is null and d.deal_id = any (v_deals)
          -- recorded while the deal was still the contact's: not after an unlink of the contact from that deal
          and exists (select 1 from public.audit_log u
                        where u.organization_id = p_org and u.entity_type = 'deals' and u.entity_id = d.deal_id
                          and u.action = 'update' and u.changes -> 'contact_id' ->> 'old' = p_id::text
                          and u.changes -> 'contact_id' ->> 'new' is null and u.created_at >= d.created_at)
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.document_server', 'erase', true);
    update public.accounting_documents d
       set cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'
     where d.organization_id = p_org and d.status = 'cancelled'
       and d.cancel_reason is distinct from 'הסיבה נמחקה (מחיקת פרטיות)'
       and ('accounting_documents:' || d.id) = any (v_children);
    perform set_config('app.document_server', '', true);
  end if;
  -- PAY-01: a payment that was ever on the record (by its entries, within the business) keeps its amount, date, method and
  -- status; its reference and note go, a cancel reason becomes the neutral text, and its entries are erased below.
  if p_type in ('contacts', 'deals') then
    perform set_config('app.payment_server', 'erase', true);
    select coalesce(array_agg(pm.id), '{}') into v_payments
      from public.payments pm
     where pm.organization_id = p_org
       and pm.id in (select a.entity_id from public.audit_log a
                        where a.organization_id = p_org and a.entity_type = 'payments' and a.entity_id is not null
                          and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                               or a.changes -> v_col ->> 'new' = p_id::text)
                         union
                         -- RVW-45: recorded on such a deal without a contact
                         select p2.id from public.payments p2
                          where p2.organization_id = p_org and p2.contact_id is null and p2.deal_id = any (v_deals)
                            -- recorded while the deal was still the contact's (as for documents above)
                            and exists (select 1 from public.audit_log u
                                         where u.organization_id = p_org and u.entity_type = 'deals' and u.entity_id = p2.deal_id
                                           and u.action = 'update' and u.changes -> 'contact_id' ->> 'old' = p_id::text
                                           and u.changes -> 'contact_id' ->> 'new' is null and u.created_at >= p2.created_at));
    -- PAY-04: the cheque's due-date reminders lose its number (matched by the stored text, before the number is emptied)
    update public.notifications n
       set body = 'צ''ק · ' || app.payment_amount_text(pm.amount_agorot)
      from public.payments pm
     where pm.organization_id = p_org and pm.id = any (v_payments) and pm.cheque_number is not null
       and n.organization_id = p_org and n.type = 'payment' and n.title = 'צ''ק לפירעון היום'
       and ((n.entity_type = 'deal' and n.entity_id = pm.deal_id) or (n.entity_type = 'contact' and n.entity_id = pm.contact_id))
       and n.body = 'צ''ק ' || pm.cheque_number || ' · ' || app.payment_amount_text(pm.amount_agorot);
    for v_child in
      update public.payments pm
         set reference = null, note = null,
             -- PAY-04: the cheque's number, a foreign bank's name and the unbounce reason go too
             cheque_number = null, cheque_bank_name = null, cheque_unbounce_reason = null,
             cancel_reason = case when pm.status = 'cancelled' then 'הסיבה נמחקה (מחיקת פרטיות)' end
       where pm.organization_id = p_org and pm.id = any (v_payments)
      returning 'payments'::text as entity_type, pm.id as entity_id
    loop
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end loop;
    perform set_config('app.payment_server', '', true);
  end if;
  -- DOC-04: the cancel reason goes from the timeline entries of those documents and payments (their audit history is erased
  -- below with the rest)
  for v_child in
    update public.activities ac
       set body = regexp_replace(ac.body, ' · סיבה: .*$', '')
     where ac.organization_id = p_org and ac.type = 'system'
       and ((ac.metadata ->> 'kind' = 'document_cancelled'
             and ('accounting_documents:' || (ac.metadata ->> 'document_id')) = any (v_children))
            or (ac.metadata ->> 'kind' = 'payment_cancelled'
             and ('payments:' || (ac.metadata ->> 'payment_id')) = any (v_children)))
       and ac.body like '% · סיבה: %'
    returning 'activities'::text as entity_type, ac.id as entity_id
  loop
    v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
  end loop;
  -- the lines of those orders (kept or gone) that are gone themselves: their entries carry order_id; ORD-04: and their
  -- payment steps, as for quotes (the steps of a kept order stay, like a quote's)
  for v_child in
    select distinct a.entity_type, a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type in ('order_lines', 'order_payment_steps') and a.entity_id is not null
       and coalesce(a.changes ->> 'order_id', a.changes -> 'order_id' ->> 'old') = any (
             select substr(c, length('orders:') + 1) from unnest(v_children) c where c like 'orders:%')
  loop
    execute format('select exists (select 1 from public.%I where organization_id = $1 and id = $2)', v_child.entity_type)
      into v_exists using p_org, v_child.entity_id;
    if not v_exists then
      v_children := v_children || (v_child.entity_type || ':' || v_child.entity_id);
    end if;
  end loop;

  -- the files of those documents and payments, kept or gone: a file's name may carry the customer's name. The file and its
  -- object stay with the document or payment (a business record); every entry of it is erased. A kept file is found by its
  -- row; a removed one by its delete entry, which holds the row (an insert's entry holds no values)
  for v_child in
    select f.id as entity_id from public.files f
     where f.organization_id = p_org
       and (f.accounting_document_id::text = any (
              select substr(c, length('accounting_documents:') + 1) from unnest(v_children) c where c like 'accounting_documents:%')
            or f.payment_id::text = any (
              select substr(c, length('payments:') + 1) from unnest(v_children) c where c like 'payments:%'))
    union
    select a.entity_id from public.audit_log a
     where a.organization_id = p_org and a.entity_type = 'files' and a.entity_id is not null
       and (coalesce(a.changes ->> 'accounting_document_id', a.changes -> 'accounting_document_id' ->> 'old') = any (
              select substr(c, length('accounting_documents:') + 1) from unnest(v_children) c where c like 'accounting_documents:%')
            or coalesce(a.changes ->> 'payment_id', a.changes -> 'payment_id' ->> 'old') = any (
              select substr(c, length('payments:') + 1) from unnest(v_children) c where c like 'payments:%'))
  loop
    v_children := v_children || ('files:' || v_child.entity_id);
  end loop;
  -- their names too (review of 020640, low 2): a name such as "חשבונית מיכל לוי.pdf" becomes "מסמך <number>.pdf" or
  -- "תשלום <date>.pdf". The file and its object stay (a tax document); the extension is kept, the name was never a fact
  update public.files f
     set name = case when f.accounting_document_id is not null
                     then 'מסמך ' || coalesce((select d.number from public.accounting_documents d
                                                where d.organization_id = f.organization_id and d.id = f.accounting_document_id), '')
                     else 'תשלום ' || coalesce((select to_char(pm.paid_on, 'YYYY-MM-DD') from public.payments pm
                                                 where pm.organization_id = f.organization_id and pm.id = f.payment_id), '')
                end || coalesce(lower(substring(f.name from '(\.[A-Za-z0-9]{1,8})$')), '')
   where f.organization_id = p_org
     and ('files:' || f.id) = any (v_children)
     and (f.accounting_document_id is not null or f.payment_id is not null);

  update public.audit_log a set changes = '{"erased": true}'::jsonb
   where a.organization_id = p_org
     and ((a.entity_type = p_type and a.entity_id = p_id) or (a.entity_type || ':' || a.entity_id) = any (v_children))
     and a.action <> 'erase'
     and a.changes is distinct from '{"erased": true}'::jsonb;
  get diagnostics v_count = row_count;

  -- the copy kept by a merge, on the record it was merged into
  update public.activities ac
     set metadata = ac.metadata - 'merged', body = 'מוזג עם רשומה כפולה (הפרטים נמחקו)'
   where ac.organization_id = p_org and ac.metadata ->> 'merged_id' = p_id::text and ac.metadata ? 'merged';
  get diagnostics v_more = row_count;
  v_count := v_count + v_more;

  v_count := v_count + app.erase_submissions(p_org, v_row);

  -- CNS-02: its consent history keeps only the hash, the state and the time
  if p_type in ('leads', 'contacts') then
    update public.consents c set method = null, wording = null, recorded_by = null, lift_note = null
     where c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id
       and (c.method is not null or c.wording is not null or c.recorded_by is not null or c.lift_note is not null);
    get diagnostics v_more = row_count;
    v_count := v_count + v_more;
    -- an entry still waiting for its hash (written without the key): with the key there,
    -- it gets its hash first, so the opt-out keeps working; then the stored address is
    -- blanked. Without the key it stays unmatchable and keeps app.consent_suppressed() at
    -- "cannot check" for its channel (fail closed).
    if app.consent_key_present() then
      update public.consents c set address_hash = app.consent_pending_hash(c.id)
       where c.organization_id = p_org
         and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
         and c.subject_id = p_id and c.address_hash is null and c.hash_version = 1
         and app.consent_pending_hash(c.id) is not null;
    end if;
    update app.consent_pending_address p set value = null
      from public.consents c
     where c.id = p.consent_id and c.organization_id = p_org
       and c.subject_type = case p_type when 'leads' then 'lead' else 'contact' end
       and c.subject_id = p_id and p.value is not null;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (p_org, p_actor, 'erase', p_type, p_id, jsonb_build_object('entries', v_count));
  return v_count;
end;
$$;
revoke all on function app.audit_erase_core(uuid, text, uuid, uuid) from public, anon, authenticated;

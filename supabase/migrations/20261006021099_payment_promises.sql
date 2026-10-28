-- =============================================================================
-- COL-03: "הבטחת תשלום": the date the customer committed to and a collection note (spec 7.5). The reminders of COL-04 are
-- held until then. Plan key `collection` (every plan). Owner's answers, 28 October 2026 (DECISIONS.md): (1) ג, (2) א plus a
-- notice when a promise was not kept.
-- =============================================================================
-- * public.payment_promises: a promise on ONE document, or on the WHOLE customer (answer (1) ג), exactly one subject:
--   `document_id`, or `contact_id` (a contact without a company: its own documents, not those on a deal with a company) or
--   `company_id`: PAY-02's customer, as BAL-02 takes it
--   (hint `payment_promise:customer` for a contact of a company: the customer is its company). At most one per document and
--   one per customer (unique). It holds the promised date and an optional note (1..500, trimmed). It is the current promise:
--   changing it (date, note) is an update, removing it is a delete; the audit log keeps every earlier value.
--   A document takes one only while it is an active tax invoice, proforma or positive opening balance (BAL-02's debt types;
--   hint `payment_promise:document`). A person's new or changed date is from the business's today up to 366 days ahead (hint
--   `payment_promise:date`); the subject never changes (hint `payment_promise:fixed`).
-- * A customer promise covers ONLY the documents that were open (a debt with a balance) when it was made, never one recorded
--   later: public.payment_promise_documents keeps that set (one row per covered document, server-made by
--   app.payment_promise_cover when the promise is inserted, never changed; ids only, not audited). The set is the open
--   documents of the customer that the person making the promise reads, with their balances as that person sees them (the
--   trigger app.payment_promises_cover is invoker; the insert itself goes through the definer app.payment_promise_cover, which
--   re-checks every id against the customer and the debt types). No open document = refused (`payment_promise:nothing_open`).
--   Changing the date or note keeps the set; to cover documents recorded later, remove the promise and make a new one.
-- * A document's effective promise (one rule, app.document_promise): its own promise, else the newest customer promise that
--   covered it. The document's own always wins.
-- * Rights: reading follows the subject (the document, the contact or the company: whoever reads it); a covered row needs
--   both the promise and the document readable. Writing is BAL-01's / PAY-06's rule, app.can_record_payments (owners,
--   admins, managers, or the record_payments key), in a writable business with the `collection` key, on a subject the
--   writer reads. Trigger app.payment_promises_check is invoker: outsider guard first, then a subject the person cannot read
--   is left to RLS (42501), so its state is never revealed. Removing a promise does not need the `collection` key (on
--   purpose: after a downgrade a person may still remove a note about a customer); recording and changing do.
-- * The rule COL-04 reads (built here, used later): app.collection_reminder_held(promised, day) = a promise holds the
--   reminders on every day up to and including the promised date (answer (2) א); app.collection_held_until(org, document)
--   answers the effective promise's date while it still holds in the business's zone, else null. No grants. Mirrored by
--   reminderHeld() in src/features/collection/promise.ts (unit test).
-- * A promise not kept (answer (2)): pg_cron `crm-promise-breaks` (every 15 minutes, as the other money jobs) runs
--   app.send_promise_breaks(): from 08:00 in the business's zone on any day after the promised date, in a writable business,
--   each promise is judged ONCE per promised date (app.payment_promise_judged: no grants, RLS on): when its document (or any
--   covered document) is still active with a balance, one notice of kind `payment` "ההבטחה לא קוימה" (the document's type
--   and number, or "הבטחת תשלום על החובות של הלקוח"; no amounts, no names) goes to the rep: for a document MNY-01's owner
--   (its deal's, else its contact's, else its company's), for a customer promise the contact's or company's owner; active
--   and not a viewer, else every active owner and admin. Reminders then resume (the date has passed). A customer promise is
--   judged only over the covered documents whose effective promise is still it (a covered document with its own promise is
--   that promise's); a proforma billed by an active tax invoice is judged by the invoice's balance. Fair: 200 per business
--   and 2,000 per run, failed promises after the fresh ones; each promise in its own exception block, which records the
--   failure and writes one warning line (promise id and SQLSTATE only); after 3 failures a promise is skipped.
-- * public.collection_documents (021098) is redefined only to add each row's effective promise (`promised_date`,
--   `promise_note`, `promise_kind` document|customer).
-- * A privacy erasure empties promise notes and erases their audit entries: app.audit_erase_core, redefined in the next
--   migration (payment_promise_erasure, shared ground, authorised by the lead for this branch).
-- * Merge: a document promise follows its document; a customer promise of a merged duplicate contact or company moves to the
--   kept one through the `merged` timeline entry (app.merge_payment_promises, under the transaction-local marker
--   `app.payment_promise_merge` = the business, the only path that moves a subject, whoever merges), unless the kept one has
--   its own (then the duplicate's goes with it, by cascade). Purge: a customer promise goes with its contact or company (cascade); its
--   entries are erased by the erasure. Full export: both tables. Sample data records no documents. Import undo leaves a
--   promise on the cancelled opening balance (a cancelled document holds no debt, so it is never shown or judged).
-- Every statement is safe to run twice. No object or row is removed.

create table if not exists public.payment_promises (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  document_id      uuid,
  contact_id       uuid,
  company_id       uuid,
  promised_date    date not null,
  note             text check (note is null or (char_length(note) between 1 and 500 and note = btrim(note))),
  created_by       uuid references auth.users (id) on delete set null,
  updated_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint payment_promises_one_subject check (num_nonnulls(document_id, contact_id, company_id) = 1),
  constraint payment_promises_document_once unique (organization_id, document_id),
  constraint payment_promises_contact_once unique (organization_id, contact_id),
  constraint payment_promises_company_once unique (organization_id, company_id),
  constraint payment_promises_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete cascade,
  constraint payment_promises_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete cascade,
  constraint payment_promises_company_fk foreign key (organization_id, company_id)
    references public.companies (organization_id, id) on delete cascade
);

alter table public.payment_promises enable row level security;

revoke all on public.payment_promises from anon, authenticated;
grant select on public.payment_promises to authenticated;
grant insert (organization_id, document_id, contact_id, company_id, promised_date, note) on public.payment_promises to authenticated;
grant update (promised_date, note) on public.payment_promises to authenticated;
grant delete on public.payment_promises to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_promises' and policyname = 'payment_promises_select') then
    create policy payment_promises_select on public.payment_promises for select to authenticated
      using (case when payment_promises.document_id is not null
                  then exists (select 1 from public.accounting_documents d
                                where d.organization_id = payment_promises.organization_id and d.id = payment_promises.document_id)
                  when payment_promises.contact_id is not null
                  then exists (select 1 from public.contacts c
                                where c.organization_id = payment_promises.organization_id and c.id = payment_promises.contact_id)
                  else exists (select 1 from public.companies co
                                where co.organization_id = payment_promises.organization_id and co.id = payment_promises.company_id)
             end);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_promises' and policyname = 'payment_promises_insert') then
    create policy payment_promises_insert on public.payment_promises for insert to authenticated
      with check (app.can_record_payments(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'collection')
                  and case when payment_promises.document_id is not null
                           then exists (select 1 from public.accounting_documents d
                                         where d.organization_id = payment_promises.organization_id and d.id = payment_promises.document_id)
                           when payment_promises.contact_id is not null
                           then exists (select 1 from public.contacts c
                                         where c.organization_id = payment_promises.organization_id and c.id = payment_promises.contact_id)
                           else exists (select 1 from public.companies co
                                         where co.organization_id = payment_promises.organization_id and co.id = payment_promises.company_id)
                      end);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_promises' and policyname = 'payment_promises_update') then
    create policy payment_promises_update on public.payment_promises for update to authenticated
      using (app.can_record_payments(organization_id) and app.org_writable(organization_id)
             and app.org_has_feature(organization_id, 'collection')
             and case when payment_promises.document_id is not null
                      then exists (select 1 from public.accounting_documents d
                                    where d.organization_id = payment_promises.organization_id and d.id = payment_promises.document_id)
                      when payment_promises.contact_id is not null
                      then exists (select 1 from public.contacts c
                                    where c.organization_id = payment_promises.organization_id and c.id = payment_promises.contact_id)
                      else exists (select 1 from public.companies co
                                    where co.organization_id = payment_promises.organization_id and co.id = payment_promises.company_id)
                 end)
      with check (app.can_record_payments(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'collection'));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_promises' and policyname = 'payment_promises_delete') then
    create policy payment_promises_delete on public.payment_promises for delete to authenticated
      using (app.can_record_payments(organization_id) and app.org_writable(organization_id)
             and case when payment_promises.document_id is not null
                      then exists (select 1 from public.accounting_documents d
                                    where d.organization_id = payment_promises.organization_id and d.id = payment_promises.document_id)
                      when payment_promises.contact_id is not null
                      then exists (select 1 from public.contacts c
                                    where c.organization_id = payment_promises.organization_id and c.id = payment_promises.contact_id)
                      else exists (select 1 from public.companies co
                                    where co.organization_id = payment_promises.organization_id and co.id = payment_promises.company_id)
                 end);
  end if;
end;
$$;

-- The documents a customer promise covered: the open ones when it was made (server-made, never changed)
create table if not exists public.payment_promise_documents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  promise_id       uuid not null,
  document_id      uuid not null,
  created_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint payment_promise_documents_once unique (organization_id, promise_id, document_id),
  constraint payment_promise_documents_promise_fk foreign key (organization_id, promise_id)
    references public.payment_promises (organization_id, id) on delete cascade,
  constraint payment_promise_documents_document_fk foreign key (organization_id, document_id)
    references public.accounting_documents (organization_id, id) on delete cascade
);
create index if not exists payment_promise_documents_promise_idx on public.payment_promise_documents (organization_id, promise_id);
create index if not exists payment_promise_documents_document_idx on public.payment_promise_documents (organization_id, document_id);

alter table public.payment_promise_documents enable row level security;
revoke all on public.payment_promise_documents from anon, authenticated;
grant select on public.payment_promise_documents to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'payment_promise_documents'
                  and policyname = 'payment_promise_documents_select') then
    create policy payment_promise_documents_select on public.payment_promise_documents for select to authenticated
      using (exists (select 1 from public.payment_promises p
                      where p.organization_id = payment_promise_documents.organization_id and p.id = payment_promise_documents.promise_id)
             and exists (select 1 from public.accounting_documents d
                          where d.organization_id = payment_promise_documents.organization_id and d.id = payment_promise_documents.document_id));
  end if;
end;
$$;

-- The open debt documents of a customer (PAY-02's customer, BAL-02's scope: a company's own, its contacts' and its deals'
-- documents; a contact without a company, its own), read with the caller's rights. Keep in step with
-- public.customer_debt_summary's scope. Invoker: under a person's RLS, only what that person reads.
create or replace function app.customer_open_documents(p_org uuid, p_contact uuid, p_company uuid) returns uuid[]
language sql stable security invoker
set search_path = ''
as $$
  with docs as (
    select d.id from public.accounting_documents d
     where d.organization_id = p_org and d.status = 'active'
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.amount_agorot > 0
       and ((p_company is not null
             and (d.company_id = p_company
                  or d.contact_id in (select c.id from public.contacts c where c.organization_id = p_org and c.company_id = p_company)
                  or d.deal_id in (select dl.id from public.deals dl where dl.organization_id = p_org and dl.company_id = p_company)))
            -- a contact without a company: its own documents, leaving out those on a deal that has a company (BAL-02 puts
            -- them under the company)
            or (p_company is null and p_contact is not null and d.contact_id = p_contact
                and not exists (select 1 from public.deals dl
                                 where dl.organization_id = p_org and dl.id = d.deal_id and dl.company_id is not null)))
  )
  select coalesce(array_agg((x ->> 'id')::uuid order by (x ->> 'id')), '{}'::uuid[])
    from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from docs), '{}'::uuid[])
                              -> 'documents') x
   where coalesce((x ->> 'balance')::bigint, 0) > 0;
$$;
revoke all on function app.customer_open_documents(uuid, uuid, uuid) from public, anon;
-- the invoker cover trigger runs as the person
grant execute on function app.customer_open_documents(uuid, uuid, uuid) to authenticated;

-- Writes the covered set of a customer promise just made (definer; the only writer of payment_promise_documents). Every id
-- is re-checked: an active debt document of that customer, in that business; the promise has no set yet.
create or replace function app.payment_promise_cover(p_org uuid, p_promise uuid, p_documents uuid[]) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_promise public.payment_promises;
  v_count integer;
begin
  select * into v_promise from public.payment_promises p where p.organization_id = p_org and p.id = p_promise;
  if v_promise.id is null or v_promise.document_id is not null
     or exists (select 1 from public.payment_promise_documents c where c.organization_id = p_org and c.promise_id = p_promise)
     or (auth.uid() is not null and not (app.can_record_payments(p_org) and app.org_writable(p_org))) then
    raise exception 'not a new customer promise' using errcode = '42501';
  end if;
  insert into public.payment_promise_documents (organization_id, promise_id, document_id)
  select p_org, p_promise, d.id
    from public.accounting_documents d
   where d.organization_id = p_org and d.id = any (p_documents)
     and d.status = 'active' and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.amount_agorot > 0
     and ((v_promise.company_id is not null
           and (d.company_id = v_promise.company_id
                or d.contact_id in (select c.id from public.contacts c where c.organization_id = p_org and c.company_id = v_promise.company_id)
                or d.deal_id in (select dl.id from public.deals dl where dl.organization_id = p_org and dl.company_id = v_promise.company_id)))
          or (v_promise.contact_id is not null and d.contact_id = v_promise.contact_id
              and not exists (select 1 from public.deals dl
                               where dl.organization_id = p_org and dl.id = d.deal_id and dl.company_id is not null)))
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function app.payment_promise_cover(uuid, uuid, uuid[]) from public, anon, service_role;
-- the invoker cover trigger runs as the person; app is not in the API
grant execute on function app.payment_promise_cover(uuid, uuid, uuid[]) to authenticated;

-- The server's values and the rules, for every writer. Security INVOKER on purpose: a person's write reads the subject under
-- the person's own RLS, so a subject the person cannot read is never judged here (its state is not revealed by a hint);
-- RLS then answers 42501 for an active and a cancelled document alike. Server writes (no auth.uid()) read every row.
create or replace function app.payment_promises_check() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_today date;
  v_readable boolean;
begin
  -- a merge moves a customer promise to the kept contact or company (app.merge_payment_promises sets the marker around its
  -- own updates, whoever merges): only the customer column moves, nothing else
  if tg_op = 'UPDATE' and current_setting('app.payment_promise_merge', true) = new.organization_id::text then
    if row(new.organization_id, new.document_id, new.promised_date, new.note, new.created_by, new.created_at)
       is not distinct from row(old.organization_id, old.document_id, old.promised_date, old.note, old.created_by, old.created_at)
       and ((old.contact_id is not null and new.contact_id is not null and new.company_id is null)
            or (old.company_id is not null and new.company_id is not null and new.contact_id is null)) then
      return new;
    end if;
    raise exception 'a merge moves only the customer of a promise' using errcode = 'P0001', hint = 'payment_promise:fixed';
  end if;
  -- outsider guard: RLS refuses (42501) a person who may not write here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_payments(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;
  -- a subject the person cannot read: RLS refuses (42501), whatever its state
  if auth.uid() is not null and tg_op = 'INSERT' then
    v_readable := case when new.document_id is not null
                       then exists (select 1 from public.accounting_documents d
                                     where d.organization_id = new.organization_id and d.id = new.document_id)
                       when new.contact_id is not null
                       then exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id)
                       when new.company_id is not null
                       then exists (select 1 from public.companies co where co.organization_id = new.organization_id and co.id = new.company_id)
                       else true end;
    if not v_readable then
      return new;
    end if;
  end if;

  if tg_op = 'UPDATE' and row(new.organization_id, new.document_id, new.contact_id, new.company_id, new.created_by, new.created_at)
                          is distinct from row(old.organization_id, old.document_id, old.contact_id, old.company_id, old.created_by, old.created_at) then
    raise exception 'a promise stays on its document or customer' using errcode = 'P0001', hint = 'payment_promise:fixed';
  end if;

  new.note := nullif(btrim(coalesce(new.note, '')), '');
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    if new.document_id is not null then
      -- BAL-02's debt types: an active tax invoice, proforma or positive opening balance
      if not exists (select 1 from public.accounting_documents d
                      where d.organization_id = new.organization_id and d.id = new.document_id and d.status = 'active'
                        and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance') and d.amount_agorot > 0) then
        raise exception 'a payment promise goes on an active invoice, proforma or opening debt'
          using errcode = 'P0001', hint = 'payment_promise:document';
      end if;
    elsif new.contact_id is not null then
      -- PAY-02's customer: a contact of a company pays as its company
      if exists (select 1 from public.contacts c
                  where c.organization_id = new.organization_id and c.id = new.contact_id and c.company_id is not null) then
        raise exception 'the customer of a contact with a company is the company' using errcode = 'P0001', hint = 'payment_promise:customer';
      end if;
    end if;
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);

  -- a person's new or changed date: from the business's today, up to 366 days ahead
  if auth.uid() is not null and (tg_op = 'INSERT' or new.promised_date is distinct from old.promised_date) then
    select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
      from public.organizations o where o.id = new.organization_id;
    if new.promised_date < v_today or new.promised_date > v_today + 366 then
      raise exception 'the promised date is from today up to a year ahead' using errcode = 'P0001', hint = 'payment_promise:date';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function app.payment_promises_check() from public, anon, authenticated;

-- A customer promise covers the customer's open documents of this moment (invoker: the ones the person reads; a server write
-- reads all). None open: refused.
create or replace function app.payment_promises_cover() returns trigger
language plpgsql security invoker
set search_path = ''
as $$
declare
  v_open uuid[];
begin
  if new.document_id is not null then
    return null;
  end if;
  v_open := app.customer_open_documents(new.organization_id, new.contact_id, new.company_id);
  if cardinality(v_open) = 0 or app.payment_promise_cover(new.organization_id, new.id, v_open) = 0 then
    raise exception 'the customer has no open debt to promise for' using errcode = 'P0001', hint = 'payment_promise:nothing_open';
  end if;
  return null;
end;
$$;
revoke all on function app.payment_promises_cover() from public, anon, authenticated;

create or replace trigger payment_promises_check before insert or update on public.payment_promises
  for each row execute function app.payment_promises_check();
create or replace trigger payment_promises_touch before update on public.payment_promises
  for each row execute function app.touch_row();
create or replace trigger payment_promises_audit after insert or update or delete on public.payment_promises
  for each row execute function app.audit_row();
create or replace trigger payment_promises_cover after insert on public.payment_promises
  for each row when (new.document_id is null) execute function app.payment_promises_cover();

-- A merge moves the duplicate's customer promise to the kept contact or company (through the `merged` entry, written before
-- the duplicate is deleted), unless the kept one has its own; the covered set moves with it (it hangs on the promise).
create or replace function app.merge_payment_promises() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  -- the one server path that moves a promise's subject (app.payment_promises_check lets it through), for this merge only
  perform set_config('app.payment_promise_merge', new.organization_id::text, true);
  if new.contact_id is not null and v_merged <> new.contact_id
     and not exists (select 1 from public.payment_promises p where p.organization_id = new.organization_id and p.contact_id = new.contact_id) then
    update public.payment_promises p set contact_id = new.contact_id
     where p.organization_id = new.organization_id and p.contact_id = v_merged
       -- the kept contact pays as a company: its customer is the company, so the duplicate's promise goes with it
       and not exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id and c.company_id is not null);
  elsif new.company_id is not null and v_merged <> new.company_id
     and not exists (select 1 from public.payment_promises p where p.organization_id = new.organization_id and p.company_id = new.company_id) then
    update public.payment_promises p set company_id = new.company_id
     where p.organization_id = new.organization_id and p.company_id = v_merged;
  end if;
  perform set_config('app.payment_promise_merge', '', true);
  return null;
end;
$$;
revoke all on function app.merge_payment_promises() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_payment_promises after insert on public.activities
  for each row
  when (new.type = 'system' and (new.contact_id is not null or new.company_id is not null) and new.metadata ? 'merged_id')
  execute function app.merge_payment_promises();

-- ----------------------------------------------------------------------------
-- The rule COL-04's reminders read
-- ----------------------------------------------------------------------------
-- a promise holds the reminders on every day up to and including the promised date (mirrored by reminderHeld())
create or replace function app.collection_reminder_held(p_promised date, p_day date) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_promised is not null and p_day is not null and p_day <= p_promised;
$$;
revoke all on function app.collection_reminder_held(date, date) from public, anon, authenticated, service_role;

-- a document's effective promise: its own, else the newest customer promise that covered it (the one rule)
create or replace function app.document_promise(p_org uuid, p_document uuid) returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.id
    from public.payment_promises p
   where p.organization_id = p_org
     and (p.document_id = p_document
          or p.id in (select c.promise_id from public.payment_promise_documents c
                       where c.organization_id = p_org and c.document_id = p_document))
   order by (p.document_id is not null) desc, p.created_at desc, p.id
   limit 1;
$$;
revoke all on function app.document_promise(uuid, uuid) from public, anon, authenticated, service_role;

-- the effective promise's date while it still holds today in the business's zone, else null
create or replace function app.collection_held_until(p_org uuid, p_document uuid) returns date
language sql stable security definer
set search_path = ''
as $$
  select pp.promised_date
    from public.payment_promises pp
    join public.organizations o on o.id = pp.organization_id
   where pp.organization_id = p_org and pp.id = app.document_promise(p_org, p_document)
     and app.collection_reminder_held(pp.promised_date, (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date);
$$;
revoke all on function app.collection_held_until(uuid, uuid) from public, anon, authenticated, service_role;

-- ----------------------------------------------------------------------------
-- A promise not kept: one notice to the rep (answer (2))
-- ----------------------------------------------------------------------------
-- kept: true / false once judged; null while only failed attempts are recorded (failures, last_attempt_at). After 3 failures
-- a promise is skipped (one warning line).
create table if not exists app.payment_promise_judged (
  promise_id       uuid not null references public.payment_promises (id) on delete cascade,
  promised_date    date not null,
  kept             boolean,
  judged_at        timestamptz,
  failures         integer not null default 0,
  last_attempt_at  timestamptz,
  primary key (promise_id, promised_date)
);
alter table app.payment_promise_judged enable row level security;
revoke all on app.payment_promise_judged from public, anon, authenticated, service_role;

create or replace function app.promise_break_per_org() returns integer language sql immutable set search_path = '' as $$ select 200 $$;
create or replace function app.promise_break_limit() returns integer language sql immutable set search_path = '' as $$ select 2000 $$;
revoke all on function app.promise_break_per_org() from public, anon, authenticated, service_role;
revoke all on function app.promise_break_limit() from public, anon, authenticated, service_role;

create or replace function app.send_promise_breaks() returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_row record;
  v_docs uuid[];
  v_open boolean;
  v_rep uuid;
  v_body text;
  v_entity_type text;
  v_entity uuid;
  v_done integer := 0;
begin
  for v_row in
    select z.* from (
      select p.organization_id, p.id, p.promised_date, p.document_id, p.contact_id, p.company_id,
             j.last_attempt_at,
             -- a promise that failed before goes after the fresh ones, so failing rows never starve the rest
             row_number() over (partition by p.organization_id
                                order by j.last_attempt_at nulls first, p.promised_date, p.id) as n
        from public.payment_promises p
        join public.organizations o on o.id = p.organization_id
        left join app.payment_promise_judged j on j.promise_id = p.id and j.promised_date = p.promised_date
       where p.promised_date < (now() at time zone app.intake_zone(o.timezone))::date
         and (now() at time zone app.intake_zone(o.timezone))::time >= time '08:00'
         and app.org_writable(p.organization_id)
         and (j.promise_id is null or (j.kept is null and j.failures < 3))
    ) z
     where z.n <= app.promise_break_per_org()
     order by z.last_attempt_at nulls first, z.organization_id, z.promised_date, z.id
     limit app.promise_break_limit()
  loop
    begin
      -- the documents this promise speaks for: its own document, or the covered ones whose effective promise is still this
      -- one (a covered document with its own promise is judged by that promise)
      v_docs := case when v_row.document_id is not null then array[v_row.document_id]
                     else array(select c.document_id from public.payment_promise_documents c
                                 where c.organization_id = v_row.organization_id and c.promise_id = v_row.id
                                   and app.document_promise(v_row.organization_id, c.document_id) = v_row.id) end;
      -- a proforma billed by an active tax invoice owes through that invoice (PAY-02): judge the invoice's balance
      v_docs := array(select coalesce((select i.id from public.accounting_documents i
                                        where i.organization_id = v_row.organization_id and i.proforma_id = d.id
                                          and i.status = 'active' and d.doc_type = 'proforma'
                                        order by i.created_at, i.id limit 1), d.id)
                        from public.accounting_documents d
                       where d.organization_id = v_row.organization_id and d.id = any (v_docs));
      -- still owed: an active covered document with a balance (money_allocation_state, every allocation counted)
      select exists (
        select 1
          from jsonb_array_elements(public.money_allocation_state(v_row.organization_id,
                 array(select d.id from public.accounting_documents d
                        where d.organization_id = v_row.organization_id and d.id = any (v_docs) and d.status = 'active'),
                 '{}'::uuid[]) -> 'documents') x
         where coalesce((x ->> 'balance')::bigint, 0) > 0)
        into v_open;
      insert into app.payment_promise_judged (promise_id, promised_date, kept, judged_at)
      values (v_row.id, v_row.promised_date, not v_open, now())
      on conflict (promise_id, promised_date) do update set kept = excluded.kept, judged_at = excluded.judged_at;
      if v_open then
        if v_row.document_id is not null then
          select coalesce(dl.owner_id, ct.owner_id, co.owner_id),
                 app.document_type_label(d.doc_type) || coalesce(' ' || d.number, ''),
                 case when d.deal_id is not null then 'deal' when d.contact_id is not null then 'contact' when d.company_id is not null then 'company' end,
                 coalesce(d.deal_id, d.contact_id, d.company_id)
            into v_rep, v_body, v_entity_type, v_entity
            from public.accounting_documents d
            left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
            left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
            left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
           where d.organization_id = v_row.organization_id and d.id = v_row.document_id;
        elsif v_row.company_id is not null then
          select co.owner_id into v_rep from public.companies co where co.organization_id = v_row.organization_id and co.id = v_row.company_id;
          v_body := 'הבטחת תשלום על החובות של הלקוח';
          v_entity_type := 'company';
          v_entity := v_row.company_id;
        else
          select ct.owner_id into v_rep from public.contacts ct where ct.organization_id = v_row.organization_id and ct.id = v_row.contact_id;
          v_body := 'הבטחת תשלום על החובות של הלקוח';
          v_entity_type := 'contact';
          v_entity := v_row.contact_id;
        end if;
        insert into public.notifications (organization_id, user_id, type, title, body, entity_type, entity_id)
        select v_row.organization_id, r.user_id, 'payment', 'ההבטחה לא קוימה', v_body, v_entity_type, v_entity
          from (
            select m.user_id from public.memberships m
             where m.organization_id = v_row.organization_id and m.user_id = v_rep and m.status = 'active' and m.role <> 'viewer'
            union
            select m.user_id from public.memberships m
             where m.organization_id = v_row.organization_id and m.status = 'active' and m.role in ('owner', 'admin')
               and not exists (select 1 from public.memberships r
                                where r.organization_id = v_row.organization_id and r.user_id = v_rep
                                  and r.status = 'active' and r.role <> 'viewer')
          ) r;
      end if;
      v_done := v_done + 1;
    exception when others then
      -- this promise is judged again on a later run, after the fresh ones; after 3 failures it is skipped. One redacted line:
      -- the promise id and the SQLSTATE only
      insert into app.payment_promise_judged (promise_id, promised_date, failures, last_attempt_at)
      values (v_row.id, v_row.promised_date, 1, now())
      on conflict (promise_id, promised_date)
        do update set failures = app.payment_promise_judged.failures + 1, last_attempt_at = excluded.last_attempt_at;
      raise warning 'crm-promise-breaks: promise % failed (SQLSTATE %)%', v_row.id, sqlstate,
        case when coalesce((select j.failures from app.payment_promise_judged j
                             where j.promise_id = v_row.id and j.promised_date = v_row.promised_date), 0) >= 3
             then ', skipped after 3 failures' else '' end;
    end;
  end loop;
  return v_done;
end;
$$;
revoke all on function app.send_promise_breaks() from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('crm-promise-breaks', '*/15 * * * *', 'select app.send_promise_breaks();');
  end if;
end;
$$;

-- ----------------------------------------------------------------------------
-- The collection screen (021098) shows each row's effective promise
-- ----------------------------------------------------------------------------
create or replace function public.collection_documents(
  p_org uuid,
  p_owner uuid default null,
  p_overdue boolean default false,
  p_bucket text default null,
  p_customer_kind text default null,
  p_customer_id uuid default null
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
set jit = off
as $$
declare
  v_out jsonb;
  v_today date;
  v_limit constant integer := 500;
  -- COL-01 (3) ב: the caller does not read every money row: documents yes, totals no
  v_partial boolean := false;
begin
  if not app.can_record_payments(p_org)
     or not (app.org_has_feature(p_org, 'collection') and app.org_has_feature(p_org, 'documents')
             and app.org_has_feature(p_org, 'payments')) then
    return jsonb_build_object('allowed', false);
  end if;
  if p_bucket is not null and p_bucket not in ('current', 'd1_30', 'd31_60', 'd61_90', 'd91_plus') then
    raise exception 'unknown age bucket' using errcode = '22023';
  end if;
  if (p_customer_kind is null) <> (p_customer_id is null)
     or (p_customer_kind is not null and p_customer_kind not in ('company', 'contact', 'deal')) then
    raise exception 'unknown customer' using errcode = '22023';
  end if;
  -- BAL-01's partial check for the business (as public.report_debt_aging); a partial view still lists what the caller reads.
  -- Owners and admins read every document and payment (BAL-02), so the count, which reads every row under RLS, is skipped
  if not app.is_admin(p_org) and coalesce(app.business_money_rows(p_org), 0) >
     (select count(*) from public.accounting_documents d where d.organization_id = p_org)
     + (select count(*) from public.payments p where p.organization_id = p_org) then
    v_partial := true;
  end if;

  select (now() at time zone coalesce(o.timezone, 'Asia/Jerusalem'))::date into v_today
    from public.organizations o where o.id = p_org;

  with cand as (
    -- public.report_debt_aging's candidates, customer and rep (keep in step)
    select d.id, d.doc_type, d.number, d.doc_date, d.due_date, d.amount_agorot, d.deal_id, d.contact_id, d.company_id,
           coalesce(d.company_id, ct.company_id, dl.company_id) as customer_company,
           coalesce(d.contact_id, dl.contact_id) as customer_contact,
           coalesce(dl.owner_id, ct.owner_id, co.owner_id) as owner_id
      from public.accounting_documents d
      left join public.deals dl on dl.organization_id = d.organization_id and dl.id = d.deal_id
      left join public.contacts ct on ct.organization_id = d.organization_id and ct.id = d.contact_id
      left join public.companies co on co.organization_id = d.organization_id and co.id = d.company_id
     where d.organization_id = p_org
       and d.status = 'active'
       and d.doc_type in ('tax_invoice', 'proforma', 'opening_balance')
       and d.amount_agorot > 0
       and (p_owner is null or coalesce(dl.owner_id, ct.owner_id, co.owner_id) = p_owner)
       and not (d.doc_type = 'proforma'
                and exists (select 1 from public.accounting_documents i
                             where i.organization_id = d.organization_id and i.proforma_id = d.id and i.status = 'active'))
       and coalesce((select sum(a.amount_agorot) from public.payment_allocations a
                      where a.organization_id = d.organization_id and a.document_id = d.id
                        and a.released_at is null and a.removed_at is null), 0)
           + coalesce((select sum(o.amount_agorot) from public.opening_credit_allocations o
                        where o.organization_id = d.organization_id and o.document_id = d.id
                          and o.released_at is null and o.removed_at is null), 0)
           < d.amount_agorot
  ),
  customers as (
    select c.*,
           case when c.customer_company is not null then 'company'
                when c.contact_id is not null then 'contact'
                else 'deal' end as customer_kind,
           coalesce(c.customer_company, c.contact_id, c.deal_id) as customer_id
      from cand c
  ),
  picked as (
    select c.* from customers c
     where p_customer_kind is null or (c.customer_kind = p_customer_kind and c.customer_id = p_customer_id)
  ),
  state as (
    select (x ->> 'id')::uuid as id, coalesce((x ->> 'balance')::bigint, 0) as balance
      from jsonb_array_elements(public.money_allocation_state(p_org, (select coalesce(array_agg(id), '{}'::uuid[]) from picked), '{}'::uuid[])
                                -> 'documents') x
  ),
  debts as (
    select p.*, s.balance, (v_today - p.due_date) as days_late,
           case when p.due_date is null or v_today - p.due_date <= 0 then 'current'
                when v_today - p.due_date <= 30 then 'd1_30'
                when v_today - p.due_date <= 60 then 'd31_60'
                when v_today - p.due_date <= 90 then 'd61_90'
                else 'd91_plus' end as bucket
      from picked p join state s on s.id = p.id
     where s.balance > 0
  ),
  shown as (
    select d.* from debts d
     where (not coalesce(p_overdue, false) or d.days_late >= 1)
       and (p_bucket is null or d.bucket = p_bucket)
  ),
  page as (
    select * from shown order by days_late desc nulls last, balance desc, id limit v_limit
  )
  select jsonb_build_object(
    'allowed', true,
    'partial', v_partial,
    'today', v_today,
    'totals', case when v_partial then null else (select jsonb_build_object(
                 'total', coalesce(sum(d.balance), 0)::bigint,
                 'overdue', coalesce(sum(d.balance) filter (where d.days_late >= 1), 0)::bigint,
                 'documents', count(*),
                 'overdue_documents', count(*) filter (where d.days_late >= 1),
                 'current', coalesce(sum(d.balance) filter (where d.bucket = 'current'), 0)::bigint,
                 'd1_30', coalesce(sum(d.balance) filter (where d.bucket = 'd1_30'), 0)::bigint,
                 'd31_60', coalesce(sum(d.balance) filter (where d.bucket = 'd31_60'), 0)::bigint,
                 'd61_90', coalesce(sum(d.balance) filter (where d.bucket = 'd61_90'), 0)::bigint,
                 'd91_plus', coalesce(sum(d.balance) filter (where d.bucket = 'd91_plus'), 0)::bigint)
                 from debts d) end,
    'shown', case when v_partial then null
                  else (select jsonb_build_object('total', coalesce(sum(s.balance), 0)::bigint, 'documents', count(*)) from shown s) end,
    'more', (select count(*) > v_limit from shown),
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', g.id, 'doc_type', g.doc_type, 'number', g.number, 'doc_date', g.doc_date, 'due_date', g.due_date,
               'amount', g.amount_agorot, 'balance', g.balance, 'days_late', g.days_late, 'bucket', g.bucket,
               'deal_id', g.deal_id, 'contact_id', g.contact_id, 'company_id', g.customer_company,
               'customer_kind', g.customer_kind, 'customer_id', g.customer_id,
               'customer_name', case g.customer_kind
                  when 'company' then (select co.name from public.companies co where co.organization_id = p_org and co.id = g.customer_id)
                  when 'contact' then (select ct.full_name from public.contacts ct where ct.organization_id = p_org and ct.id = g.customer_id)
                  else (select dl.name from public.deals dl where dl.organization_id = p_org and dl.id = g.customer_id) end,
               'owner_id', g.owner_id,
               -- COL-03: the document's effective promise (its own, else the newest customer promise that covered it)
               'promised_date', pp.promised_date, 'promise_note', pp.note, 'promise_kind', pp.kind,
               -- COL-05: the customer is held (the document's or its deal's contact, or the customer's company)
               'held', exists (select 1 from public.customer_holds h
                                where h.organization_id = p_org and h.cleared_at is null
                                  and ((g.customer_contact is not null and h.contact_id = g.customer_contact)
                                       or (g.customer_company is not null and h.company_id = g.customer_company))))
               order by g.days_late desc nulls last, g.balance desc, g.id)
        from page g
        left join lateral (
          select p.promised_date, p.note, case when p.document_id is null then 'customer' else 'document' end as kind
            from public.payment_promises p
           where p.organization_id = p_org
             and (p.document_id = g.id
                  or p.id in (select c.promise_id from public.payment_promise_documents c
                               where c.organization_id = p_org and c.document_id = g.id))
           -- the rule of app.document_promise (keep in step), under the caller's RLS
           order by (p.document_id is not null) desc, p.created_at desc, p.id
           limit 1) pp on true), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function public.collection_documents(uuid, uuid, boolean, text, text, uuid) from public, anon;
grant execute on function public.collection_documents(uuid, uuid, boolean, text, text, uuid) to authenticated;

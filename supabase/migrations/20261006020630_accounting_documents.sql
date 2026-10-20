-- =============================================================================
-- DOC-01: recording an accounting document issued outside the system (owner, 20 October 2026, DECISIONS.md "רישום מסמך
-- חשבונאי חיצוני"; plan key `documents`, every plan)
-- =============================================================================
-- * public.accounting_documents: one row per external document on a deal and/or a contact: type from a closed list
--   (tax_invoice, tax_invoice_receipt, receipt, credit_invoice, proforma), number (required, 1..40, trimmed), date, amount in
--   agorot and currency ('ILS' only, as every money table). The same type and number twice in one business is refused
--   (hint document:duplicate; unique index accounting_documents_number_once behind it), cancelled ones included.
-- * Who records: owners, admins and managers by role, and holders of the new PRM-01 key `documents`
--   (app.can_record_documents; the key joins app.member_permission_keys, the constraint member_permissions_known and the
--   built list). Reading follows the deal, else the contact (as orders); a document left with neither (both purged) is read
--   by owners, admins and managers by role. Insert needs a deal or contact the caller reads, live, in a writable business
--   with the flag.
-- * Never deleted (no delete grant or policy): it is cancelled with a reason (1..500), by the same people, and never
--   comes back; a person changes nothing else (hint document:frozen). The cancel time and person are the server's.
--   Definer trigger app.accounting_documents_check (outsider guard first, so a stranger learns nothing about another
--   business's numbers). Audited (app.audit_row).
-- * A purged deal or contact leaves the document, its link cleared by the composite FK (on delete set null of the column).
--   A contact merge moves the duplicate's documents to the kept contact through the `merged` timeline entry
--   (app.merge_accounting_documents), as ORD-01 did until app.merge_move_links (shared ground) takes it over.
-- * app.sample_untouched and app.import_record_worked (the bodies of 020570) count a document as real work.
-- * Privacy erasure (app.audit_erase_core, the body of 020625): a document that was ever on the erased contact or deal (found
--   through its audit entries, within the business) keeps its type, number, date, amount and state; a cancel reason, which
--   staff may have written with the customer's name, becomes the neutral ERASED_REASON; its entries are erased.
--   The trigger lets only that server change through (setting app.document_server = 'erase').
-- * No file yet: linking one through public.files needs the shared files mechanism (lane ד follow-up).
-- Every statement is safe to run twice. No drops, no row removal.

-- ----------------------------------------------------------------------------
-- PRM-01: the key `documents`
-- ----------------------------------------------------------------------------
create or replace function app.member_permission_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['issue_documents', 'issue_credits', 'record_payments', 'view_costs', 'export', 'import',
               'edit_catalog', 'mass_send', 'manage_automations', 'documents']::text[]
$$;
revoke all on function app.member_permission_keys() from public, anon;
grant execute on function app.member_permission_keys() to authenticated, service_role;

alter table public.member_permissions drop constraint if exists member_permissions_known;
alter table public.member_permissions add constraint member_permissions_known check (
  permissions <@ array['issue_documents', 'issue_credits', 'record_payments', 'view_costs', 'export', 'import',
                       'edit_catalog', 'mass_send', 'manage_automations', 'documents']::text[]
  and array_position(permissions, null) is null);

create or replace function app.member_permission_built_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array['export', 'import', 'edit_catalog', 'manage_automations', 'view_costs', 'documents']::text[]
$$;
revoke all on function app.member_permission_built_keys() from public, anon;
grant execute on function app.member_permission_built_keys() to authenticated, service_role;

-- owners, admins and managers by role, or the personal key
create or replace function app.can_record_documents(p_org uuid) returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce(app.role_in(p_org)::text in ('owner', 'admin', 'manager'), false) or app.has_grant(p_org, 'documents');
$$;
revoke all on function app.can_record_documents(uuid) from public, anon;
grant execute on function app.can_record_documents(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- The table
-- ----------------------------------------------------------------------------
create table if not exists public.accounting_documents (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations (id) on delete cascade,
  deal_id          uuid,
  contact_id       uuid,
  doc_type         text not null check (doc_type in ('tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma')),
  number           text not null check (char_length(number) between 1 and 40 and number = btrim(number)),
  doc_date         date not null default current_date,
  amount_agorot    bigint not null check (amount_agorot between 0 and 1000000000000),
  currency         text not null default 'ILS' check (currency = 'ILS'),
  status           text not null default 'active' check (status in ('active', 'cancelled')),
  cancel_reason    text check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500),
  cancelled_at     timestamptz,
  cancelled_by     uuid references auth.users (id) on delete set null,
  created_by       uuid references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, id),
  constraint accounting_documents_deal_fk foreign key (organization_id, deal_id)
    references public.deals (organization_id, id) on delete set null (deal_id),
  constraint accounting_documents_contact_fk foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id) on delete set null (contact_id),
  constraint accounting_documents_cancel_shape check (
    (status = 'active' and cancel_reason is null and cancelled_at is null)
    or (status = 'cancelled' and cancel_reason is not null and cancelled_at is not null))
);

create unique index if not exists accounting_documents_number_once on public.accounting_documents (organization_id, doc_type, number);
create index if not exists accounting_documents_deal_idx on public.accounting_documents (organization_id, deal_id);
create index if not exists accounting_documents_contact_idx on public.accounting_documents (organization_id, contact_id);

alter table public.accounting_documents enable row level security;

revoke all on public.accounting_documents from anon, authenticated;
grant select on public.accounting_documents to authenticated;
grant insert (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, currency) on public.accounting_documents to authenticated;
-- cancelling is the only change a person makes
grant update (status, cancel_reason) on public.accounting_documents to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'accounting_documents' and policyname = 'accounting_documents_select') then
    create policy accounting_documents_select on public.accounting_documents for select to authenticated
      using (case when accounting_documents.deal_id is not null
                  then exists (select 1 from public.deals d where d.organization_id = accounting_documents.organization_id and d.id = accounting_documents.deal_id)
                  when accounting_documents.contact_id is not null
                  then exists (select 1 from public.contacts c where c.organization_id = accounting_documents.organization_id and c.id = accounting_documents.contact_id)
                  else coalesce(app.role_in(accounting_documents.organization_id) in ('owner', 'admin', 'manager'), false)
             end);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'accounting_documents' and policyname = 'accounting_documents_insert') then
    create policy accounting_documents_insert on public.accounting_documents for insert to authenticated
      with check (app.can_record_documents(organization_id) and app.org_writable(organization_id)
                  and app.org_has_feature(organization_id, 'documents')
                  and (deal_id is not null or contact_id is not null)
                  and (deal_id is null or exists (select 1 from public.deals d
                                                   where d.organization_id = accounting_documents.organization_id
                                                     and d.id = accounting_documents.deal_id and d.deleted_at is null))
                  and (contact_id is null or exists (select 1 from public.contacts c
                                                      where c.organization_id = accounting_documents.organization_id
                                                        and c.id = accounting_documents.contact_id and c.deleted_at is null)));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'accounting_documents' and policyname = 'accounting_documents_update') then
    create policy accounting_documents_update on public.accounting_documents for update to authenticated
      using (app.can_record_documents(organization_id) and app.org_writable(organization_id)
             and case when accounting_documents.deal_id is not null
                      then exists (select 1 from public.deals d where d.organization_id = accounting_documents.organization_id and d.id = accounting_documents.deal_id)
                      when accounting_documents.contact_id is not null
                      then exists (select 1 from public.contacts c where c.organization_id = accounting_documents.organization_id and c.id = accounting_documents.contact_id)
                      else coalesce(app.role_in(accounting_documents.organization_id) in ('owner', 'admin', 'manager'), false)
                 end)
      with check (app.can_record_documents(organization_id) and app.org_writable(organization_id));
  end if;
end;
$$;

-- The server's values, the duplicate check, and the one change a person makes (every writer)
create or replace function app.accounting_documents_check() returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  -- outsider guard: RLS refuses (42501) a person who may not record documents here, before anything is revealed
  if auth.uid() is not null and not (app.can_record_documents(new.organization_id) and app.org_writable(new.organization_id)) then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.number := btrim(coalesce(new.number, ''));
    new.status := 'active';
    new.cancel_reason := null;
    new.cancelled_at := null;
    new.cancelled_by := null;
    new.created_by := coalesce(auth.uid(), new.created_by);
    if new.deal_id is null and new.contact_id is null then
      raise exception 'a document belongs to a deal or a contact' using errcode = 'P0001', hint = 'document:parent';
    end if;
    -- the same type and number once per business (the unique index stays behind it for a race)
    perform pg_advisory_xact_lock(hashtextextended('accounting_documents:' || new.organization_id::text || ':' || new.doc_type || ':' || new.number, 0));
    if exists (select 1 from public.accounting_documents a
                where a.organization_id = new.organization_id and a.doc_type = new.doc_type and a.number = new.number) then
      raise exception 'a document of this type and number is already recorded' using errcode = 'P0001', hint = 'document:duplicate';
    end if;
    return new;
  end if;

  -- UPDATE. A purge clears the deal or the contact through the composite FK (a nested trigger): only that passes
  if pg_trigger_depth() > 1
     and (row(new.organization_id, new.doc_type, new.number, new.doc_date, new.amount_agorot, new.currency, new.status,
              new.cancel_reason, new.cancelled_at, new.cancelled_by, new.created_by, new.created_at)
          is not distinct from
          row(old.organization_id, old.doc_type, old.number, old.doc_date, old.amount_agorot, old.currency, old.status,
              old.cancel_reason, old.cancelled_at, old.cancelled_by, old.created_by, old.created_at))
     and (new.deal_id is not distinct from old.deal_id or new.deal_id is null)
     and (new.contact_id is not distinct from old.contact_id or new.contact_id is null) then
    return new;
  end if;
  -- a privacy erasure replaces a cancel reason with the neutral text (app.audit_erase_core sets the flag for its update only)
  if current_setting('app.document_server', true) = 'erase'
     and old.status = 'cancelled'
     and new.cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'
     and row(new.organization_id, new.deal_id, new.contact_id, new.doc_type, new.number, new.doc_date, new.amount_agorot,
             new.currency, new.status, new.cancelled_at, new.cancelled_by, new.created_by, new.created_at)
         is not distinct from
         row(old.organization_id, old.deal_id, old.contact_id, old.doc_type, old.number, old.doc_date, old.amount_agorot,
             old.currency, old.status, old.cancelled_at, old.cancelled_by, old.created_by, old.created_at) then
    return new;
  end if;
  -- a merge moves the duplicate contact's documents (app.merge_accounting_documents sets the flag for its updates only)
  if current_setting('app.document_server', true) = 'on'
     and row(new.organization_id, new.deal_id, new.doc_type, new.number, new.doc_date, new.amount_agorot, new.currency,
             new.status, new.cancel_reason, new.cancelled_at, new.cancelled_by)
         is not distinct from
         row(old.organization_id, old.deal_id, old.doc_type, old.number, old.doc_date, old.amount_agorot, old.currency,
             old.status, old.cancel_reason, old.cancelled_at, old.cancelled_by) then
    return new;
  end if;
  -- (the currency is held to 'ILS' by its check until DEAL-12; then it joins this list)
  if row(new.organization_id, new.deal_id, new.contact_id, new.doc_type, new.number, new.doc_date, new.amount_agorot,
         new.created_by, new.created_at)
     is distinct from
     row(old.organization_id, old.deal_id, old.contact_id, old.doc_type, old.number, old.doc_date, old.amount_agorot,
         old.created_by, old.created_at) then
    raise exception 'a recorded document does not change; cancel it instead' using errcode = 'P0001', hint = 'document:frozen';
  end if;
  if old.status = 'cancelled' then
    if new.status is distinct from old.status or new.cancel_reason is distinct from old.cancel_reason
       or new.cancelled_at is distinct from old.cancelled_at or new.cancelled_by is distinct from old.cancelled_by then
      raise exception 'a cancelled document stays cancelled' using errcode = 'P0001', hint = 'document:cancelled';
    end if;
    return new;
  end if;
  if new.status = 'active' then
    if new.cancel_reason is not null then
      raise exception 'a reason goes with a cancellation' using errcode = 'P0001', hint = 'document:cancel_reason';
    end if;
    new.cancelled_at := null;
    new.cancelled_by := null;
    return new;
  end if;
  -- cancelling: the reason is required, the time and the person are the server's
  new.cancel_reason := nullif(btrim(coalesce(new.cancel_reason, '')), '');
  if new.cancel_reason is null or char_length(new.cancel_reason) > 500 then
    raise exception 'cancelling needs a reason' using errcode = 'P0001', hint = 'document:cancel_reason';
  end if;
  new.cancelled_at := now();
  new.cancelled_by := auth.uid();
  return new;
end;
$$;
revoke all on function app.accounting_documents_check() from public, anon, authenticated;

create or replace trigger accounting_documents_check before insert or update on public.accounting_documents
  for each row execute function app.accounting_documents_check();
create or replace trigger accounting_documents_touch before insert or update on public.accounting_documents
  for each row execute function app.touch_row();
create or replace trigger accounting_documents_audit after insert or update or delete on public.accounting_documents
  for each row execute function app.audit_row();

-- ----------------------------------------------------------------------------
-- A contact merge moves the duplicate's documents (through the `merged` entry, as ORD-01 did; app.merge_move_links is
-- shared ground and takes it over later)
-- ----------------------------------------------------------------------------
create or replace function app.merge_accounting_documents() returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_merged uuid;
  v_server text;
begin
  if (new.metadata ->> 'merged_id') !~ '^[0-9a-fA-F-]{36}$' then
    return null;
  end if;
  v_merged := (new.metadata ->> 'merged_id')::uuid;
  if new.contact_id is not null and v_merged <> new.contact_id
     and exists (select 1 from public.contacts c where c.organization_id = new.organization_id and c.id = new.contact_id) then
    v_server := current_setting('app.document_server', true);
    perform set_config('app.document_server', 'on', true);
    update public.accounting_documents a set contact_id = new.contact_id
     where a.organization_id = new.organization_id and a.contact_id = v_merged;
    perform set_config('app.document_server', coalesce(v_server, ''), true);
  end if;
  return null;
end;
$$;
revoke all on function app.merge_accounting_documents() from public, anon, authenticated, service_role;

create or replace trigger activities_merge_accounting_documents after insert on public.activities
  for each row
  when (new.type = 'system' and new.contact_id is not null and new.metadata ? 'merged_id')
  execute function app.merge_accounting_documents();

-- ----------------------------------------------------------------------------
-- Sample data and undo of one's own import: a document is real work (the bodies of 020570)
-- ----------------------------------------------------------------------------
create or replace function app.sample_untouched(p_org uuid, p_type text, p_id uuid, p_snapshot jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_col text := p_type || '_id';
  v_found boolean;
begin
  if app.sample_row(p_org, p_type, p_id) is distinct from p_snapshot then
    return false;
  end if;
  if p_type = 'task' then
    -- TASK-06: a sample task a person gave steps to is real work
    return not exists (select 1 from public.task_checklist_items i where i.organization_id = p_org and i.task_id = p_id);
  end if;
  -- notes, files and meetings are never sample data
  execute format(
    'select exists (select 1 from public.activities where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.files where organization_id = $1 and %1$I = $2)
         or exists (select 1 from public.meetings where organization_id = $1 and %1$I = $2)', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  -- a task that is not an unchanged sample task, or one a person gave steps to (TASK-06; removing the record would
  -- take such a task with it)
  execute format(
    'select exists (select 1 from public.tasks t where t.organization_id = $1 and t.%1$I = $2
                     and (not app.sample_pristine($1, ''task'', t.id)
                          or exists (select 1 from public.task_checklist_items i
                                      where i.organization_id = t.organization_id and i.task_id = t.id)))', v_col)
    into v_found using p_org, p_id;
  if v_found then
    return false;
  end if;
  if p_type = 'lead' then
    return not exists (select 1 from public.form_submissions f where f.organization_id = p_org and f.lead_id = p_id)
       -- CNS-01: sample data records no consent; one recorded is real work
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.lead_id = p_id)
       -- CON-06: a referral by the lead
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and cr.lead_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.lead_id = p_id);
  elsif p_type = 'contact' then
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.contact_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_contact_id = p_id)
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.contact_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-01: sample data adds no further phones or emails; one added is real work
       and not exists (select 1 from public.contact_channels ch where ch.organization_id = p_org and ch.contact_id = p_id)
       -- CNS-01: a consent recorded on it
       and not exists (select 1 from public.consents cn where cn.organization_id = p_org and cn.contact_id = p_id)
       -- CON-05: a further company, or a role at the primary one
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.contact_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- CON-06: sample data makes no relations; one made is real work
       and not exists (select 1 from public.contact_relations cr where cr.organization_id = p_org and p_id in (cr.contact_id, cr.related_contact_id))
       -- QUO-01: sample data makes no quotes; one made is real work
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.contact_id = p_id)
       -- ORD-01: sample data makes no orders; one made is real work
       and not exists (select 1 from public.orders od where od.organization_id = p_org and p_id in (od.contact_id, od.delivery_contact_id))
       -- DOC-01: sample data records no documents; one recorded is real work
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.contact_id = p_id)
       -- SEG-01: put in a list by a person
       and not exists (select 1 from public.segment_members sm where sm.organization_id = p_org and sm.contact_id = p_id);
  elsif p_type = 'company' then
    return not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_company_id = p_id)
       and not exists (select 1 from public.companies c where c.organization_id = p_org and c.parent_company_id = p_id)
       and not exists (select 1 from public.contacts c where c.organization_id = p_org and c.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'contact', c.id))
       and not exists (select 1 from public.deals d where d.organization_id = p_org and d.company_id = p_id
                         and not app.sample_untouched_id(p_org, 'deal', d.id))
       -- CON-05: someone linked to it as a further company, or given a role there
       and not exists (select 1 from public.contact_companies cc where cc.organization_id = p_org and cc.company_id = p_id
                         and (not cc.is_primary or cc.title is not null))
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.company_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.company_id = p_id);
  else -- deal
    return not exists (select 1 from public.deal_contacts dc where dc.organization_id = p_org and dc.deal_id = p_id)
       and not exists (select 1 from public.leads l where l.organization_id = p_org and l.converted_deal_id = p_id)
       -- DLI-01: sample data adds no product lines; one added is real work
       and not exists (select 1 from public.deal_lines dl where dl.organization_id = p_org and dl.deal_id = p_id)
       -- QUO-01
       and not exists (select 1 from public.quotes qt where qt.organization_id = p_org and qt.deal_id = p_id)
       -- ORD-01
       and not exists (select 1 from public.orders od where od.organization_id = p_org and od.deal_id = p_id)
       -- DOC-01
       and not exists (select 1 from public.accounting_documents ad where ad.organization_id = p_org and ad.deal_id = p_id);
  end if;
end;
$$;

revoke all on function app.sample_untouched(uuid, text, uuid, jsonb) from public, anon, authenticated;

create or replace function app.import_record_worked(p_org uuid, p_type text, p_id uuid, p_since timestamptz, p_job uuid)
returns boolean
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_col text := case p_type when 'lead' then 'lead_id' when 'contact' then 'contact_id'
                            when 'company' then 'company_id' when 'deal' then 'deal_id' end;
  v_found boolean;
begin
  -- RVW-36: an imported task is worked on when a checklist step was added after the import or any step is done
  if p_type = 'task' then
    return exists (select 1 from public.task_checklist_items x
                    where x.organization_id = p_org and x.task_id = p_id
                      and (x.created_at > p_since or x.done_at is not null));
  end if;
  -- no other records are linked to an imported task; its own row and its steps are the whole story
  if v_col is null then
    return false;
  end if;
  execute format(
    'select exists (select 1 from public.activities x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.tasks x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.meetings x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.files x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)
         or exists (select 1 from public.record_followers x where x.organization_id = $1 and x.%1$I = $2 and x.created_at > $3)',
    v_col)
    into v_found using p_org, p_id, p_since;
  if v_found then
    return true;
  end if;
  if p_type = 'lead' then
    return exists (select 1 from public.consents x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- CON-06: a referral by the lead, made after the import
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.lead_id = p_id and x.created_at > p_since);
  elsif p_type = 'contact' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.contact_id = p_id)
        -- ORD-01: an order is always made after the import
        or exists (select 1 from public.orders x where x.organization_id = p_org and p_id in (x.contact_id, x.delivery_contact_id))
        -- DOC-01: a document is always recorded after the import
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.contact_id = p_id)
        or exists (select 1 from public.consents x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.contact_channels x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        -- put on a deal later, or a deal from outside this import points at it
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.contact_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: a company linked, or a role changed, after the import
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.contact_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since)
        -- CON-06: a relation made after the import, on either side
        or exists (select 1 from public.contact_relations x where x.organization_id = p_org
                     and p_id in (x.contact_id, x.related_contact_id) and x.created_at > p_since)
        -- SEG-01: put in a static segment after the import
        or exists (select 1 from public.segment_members x where x.organization_id = p_org and x.contact_id = p_id and x.created_at > p_since);
  elsif p_type = 'company' then
    -- a contact, deal or company from outside this import points at it (made later, or moved onto it later)
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.company_id = p_id)
        or exists (select 1 from public.contacts x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.company_id = p_id
                     and x.import_job_id is distinct from p_job)
        or exists (select 1 from public.companies x where x.organization_id = p_org and x.parent_company_id = p_id
                     and x.import_job_id is distinct from p_job)
        -- CON-05: someone linked to it, or given a role there, after the import; links of this import's own contacts
        -- (written in a later chunk of it) are not work
        or exists (select 1 from public.contact_companies x where x.organization_id = p_org and x.company_id = p_id
                     and greatest(x.created_at, x.updated_at) > p_since
                     and not exists (select 1 from public.contacts k
                                      where k.organization_id = p_org and k.id = x.contact_id and k.import_job_id = p_job));
  elsif p_type = 'deal' then
    return exists (select 1 from public.quotes x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.orders x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.accounting_documents x where x.organization_id = p_org and x.deal_id = p_id)
        or exists (select 1 from public.deal_lines x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        or exists (select 1 from public.deal_contacts x where x.organization_id = p_org and x.deal_id = p_id and x.created_at > p_since)
        -- a follow-up deal from outside this import points at it (DEAL-11)
        or exists (select 1 from public.deals x where x.organization_id = p_org and x.previous_deal_id = p_id
                     and x.import_job_id is distinct from p_job);
  end if;
  return false;
end;
$$;
revoke all on function app.import_record_worked(uuid, text, uuid, timestamptz, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- Privacy erasure: 020625's app.audit_erase_core, plus the documents that were on the erased record
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
     where a.organization_id = p_org and a.entity_type in ('tasks', 'files', 'activities', 'deal_lines', 'quotes', 'orders', 'accounting_documents') and a.entity_id is not null
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
  if p_type in ('contacts', 'deals') then
    for v_child in
      select 'accounting_documents'::text as entity_type, d.id as entity_id
        from public.accounting_documents d
       where d.organization_id = p_org
         and d.id in (select a.entity_id from public.audit_log a
                       where a.organization_id = p_org and a.entity_type = 'accounting_documents' and a.entity_id is not null
                         and (a.changes ->> v_col = p_id::text or a.changes -> v_col ->> 'old' = p_id::text
                              or a.changes -> v_col ->> 'new' = p_id::text))
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

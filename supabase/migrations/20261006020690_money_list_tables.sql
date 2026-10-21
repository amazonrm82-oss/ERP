-- LST-09 for the money lists (owner, 21 October 2026): a business-wide list of the accounting documents (DOC-01) and one of
-- the payments (PAY-01), each with the shared list pieces: the user's columns (LST-03), saved views (LST-04), the advanced
-- filter (LST-05) and the filtered or picked export (LST-08), as the quotes list (020600).
-- * list_preferences and saved_views gain the object types 'document' and 'payment'; their rows, grants and policies are
--   unchanged.
-- * public.log_list_export (the body of 020600) learns 'document' -> 'accounting_documents' and 'payment' -> 'payments', and
--   refuses either while the business's plan lacks its key (`documents`, `payments`; hint feature:<key>), as public.log_export
--   does for a report of a plan capability. The export rule itself is unchanged (app.can_export).
-- * app.export_choice_values (the body of 020600) adds the document types, the document status 'active', the payment
--   methods and the payment statuses, so an export's audit keeps a filter on them (nothing typed).
-- * Computed fields for sorting, with the caller's rights (invoker, as 0032 / 0035 / 020600): sort_customer(...) = the
--   contact's name, else the deal's name, as the lists show the customer; sort_recorder(...) = the name of who recorded it.
-- * The lists read with the user's session, so the select policies of accounting_documents and payments decide every row;
--   nothing is edited from a list (owner: only "export the picked rows").
--
-- A correction to the header of 20261006020680_customer_holds (COL-05), which is applied and cannot be edited: when a contact
-- or company is merged, ALL the duplicate's holds move to the kept record, the lifted ones (its history) included; when the
-- kept record is held already, the duplicate's active hold is lifted by the server first and then moves with the rest. The
-- history does not go away with the duplicate. The code is right; only that sentence of the header was wrong.
--
-- Every statement is safe to run twice. No drops of data, no row removal.

alter table public.list_preferences drop constraint if exists list_preferences_object_type_check;
alter table public.list_preferences add constraint list_preferences_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'deal_board', 'product', 'quote', 'document', 'payment'));

alter table public.saved_views drop constraint if exists saved_views_object_type_check;
alter table public.saved_views add constraint saved_views_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'product', 'quote', 'document', 'payment'));

create or replace function public.log_list_export(
  p_org uuid,
  p_object text,
  p_format text,
  p_rows integer,
  p_scope text,
  p_filters jsonb
) returns void
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_table text := case p_object when 'lead' then 'leads' when 'contact' then 'contacts' when 'company' then 'companies'
                                when 'deal' then 'deals' when 'task' then 'tasks' when 'product' then 'products'
                                when 'quote' then 'quotes' when 'document' then 'accounting_documents'
                                when 'payment' then 'payments' end;
  -- LST-09: a money list exists only with its plan key
  v_feature text := case p_object when 'document' then 'documents' when 'payment' then 'payments' end;
begin
  if not app.can_export(p_org) then
    raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
  end if;
  if v_table is null or p_format not in ('csv', 'xlsx') or p_scope not in ('filtered', 'selected')
     or p_rows is null or p_rows < 0 or p_rows > 1000000 then
    raise exception 'invalid export' using errcode = '22023';
  end if;
  if v_feature is not null and not app.org_has_feature(p_org, v_feature) then
    raise exception 'this list is not in the plan' using errcode = 'P0001', hint = 'feature:' || v_feature;
  end if;

  insert into public.audit_log (organization_id, actor_id, action, entity_type, entity_id, changes)
  values (
    p_org, auth.uid(), 'export', v_table, null,
    jsonb_build_object('format', p_format, 'rows', p_rows, 'scope', p_scope)
      -- the filters as the list had them, without typed text; left out when they
      -- are not an object or too large to keep
      || case when jsonb_typeof(p_filters) = 'object' and pg_column_size(p_filters) <= 8192
              then jsonb_build_object('filters', app.export_filters(p_filters)) else '{}'::jsonb end
  );
end;
$$;
revoke all on function public.log_list_export(uuid, text, text, integer, text, jsonb) from public, anon;
grant execute on function public.log_list_export(uuid, text, text, integer, text, jsonb) to authenticated;

create or replace function app.export_choice_values() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    -- deal status, task status
    'open', 'won', 'lost', 'done', 'cancelled',
    -- task type
    'todo', 'call', 'meeting', 'follow_up',
    -- task priority
    '1', '2', '3',
    -- company industry
    'services', 'real_estate', 'insurance_finance', 'construction', 'retail', 'health',
    'education', 'marketing', 'technology', 'tourism_events', 'nonprofit', 'other',
    -- CON-10: contact preferred language
    'he', 'ar', 'en', 'ru', 'am', 'fr', 'es',
    -- CON-10: contact preferred channel
    'phone', 'whatsapp', 'email', 'sms',
    -- LST-09: product kind, VAT kind and billing
    'product', 'service', 'subscription', 'bundle',
    'taxable', 'exempt', 'zero_rate',
    'one_time', 'monthly', 'quarterly', 'yearly',
    -- LST-09: quote status codes ('cancelled' is above)
    'draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired',
    -- LST-09: accounting document types and status ('cancelled' is above)
    'tax_invoice', 'tax_invoice_receipt', 'receipt', 'credit_invoice', 'proforma', 'active',
    -- LST-09: payment methods ('other' is above) and statuses ('cancelled' is above)
    'credit', 'transfer', 'cash', 'cheque', 'bit_paybox', 'standing_order',
    'recorded', 'confirmed', 'failed', 'refunded'
  ];
$$;

revoke all on function app.export_choice_values() from public, anon, authenticated;

-- Computed fields for sorting the two lists, with the caller's rights: the customer as the lists show it (the contact's
-- name, else the deal's name), and who recorded the row.
create or replace function public.sort_customer(public.accounting_documents) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(
    (select c.full_name from public.contacts c where c.organization_id = $1.organization_id and c.id = $1.contact_id),
    (select d.name from public.deals d where d.organization_id = $1.organization_id and d.id = $1.deal_id)
  );
$$;

create or replace function public.sort_customer(public.payments) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(
    (select c.full_name from public.contacts c where c.organization_id = $1.organization_id and c.id = $1.contact_id),
    (select d.name from public.deals d where d.organization_id = $1.organization_id and d.id = $1.deal_id)
  );
$$;

create or replace function public.sort_recorder(public.accounting_documents) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.created_by;
$$;

create or replace function public.sort_recorder(public.payments) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.created_by;
$$;

revoke all on function public.sort_customer(public.accounting_documents) from public, anon;
revoke all on function public.sort_customer(public.payments) from public, anon;
revoke all on function public.sort_recorder(public.accounting_documents) from public, anon;
revoke all on function public.sort_recorder(public.payments) from public, anon;
grant execute on function public.sort_customer(public.accounting_documents) to authenticated;
grant execute on function public.sort_customer(public.payments) to authenticated;
grant execute on function public.sort_recorder(public.accounting_documents) to authenticated;
grant execute on function public.sort_recorder(public.payments) to authenticated;

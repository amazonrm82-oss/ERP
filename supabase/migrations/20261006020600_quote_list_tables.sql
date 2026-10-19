-- LST-09 for quotes: the quotes list gets the shared list pieces (the user's columns, LST-03; saved views, LST-04; the
-- filtered or picked export, LST-08). list_preferences and saved_views only gain the object type 'quote'; their rows,
-- grants and policies are unchanged. public.log_list_export (the body of 020000) learns 'quote' -> 'quotes', and
-- app.export_choice_values (the body of 020280) the quote statuses, so an export's audit keeps a status filter.
-- The advanced filter (LST-05) lives in the app and reads with the user's session, so RLS on quotes decides.
-- Every statement is safe to run twice. No drops of data, no row removal.

alter table public.list_preferences drop constraint if exists list_preferences_object_type_check;
alter table public.list_preferences add constraint list_preferences_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'deal_board', 'product', 'quote'));

alter table public.saved_views drop constraint if exists saved_views_object_type_check;
alter table public.saved_views add constraint saved_views_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'product', 'quote'));

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
                                when 'quote' then 'quotes' end;
begin
  if not app.can_export(p_org) then
    raise exception 'export is for owners, admins, team managers and members with the export permission' using errcode = '42501';
  end if;
  if v_table is null or p_format not in ('csv', 'xlsx') or p_scope not in ('filtered', 'selected')
     or p_rows is null or p_rows < 0 or p_rows > 1000000 then
    raise exception 'invalid export' using errcode = '22023';
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
    'draft', 'sent', 'viewed', 'accepted', 'rejected', 'expired'
  ];
$$;

revoke all on function app.export_choice_values() from public, anon, authenticated;

-- Computed fields for sorting the quotes table (as in 0032 and 0035), with the caller's rights: the owner's name, and the
-- customer as the list shows it (the name the quote kept when sent, else its contact's name, else its deal's name).
create or replace function public.sort_owner(public.quotes) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(nullif(btrim(p.full_name), ''), p.email) from public.profiles p where p.id = $1.owner_id;
$$;

create or replace function public.sort_customer(public.quotes) returns text
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(
    $1.customer_name,
    (select c.full_name from public.contacts c where c.organization_id = $1.organization_id and c.id = $1.contact_id),
    (select d.name from public.deals d where d.organization_id = $1.organization_id and d.id = $1.deal_id)
  );
$$;

revoke all on function public.sort_owner(public.quotes) from public, anon;
revoke all on function public.sort_customer(public.quotes) from public, anon;
grant execute on function public.sort_owner(public.quotes) to authenticated;
grant execute on function public.sort_customer(public.quotes) to authenticated;

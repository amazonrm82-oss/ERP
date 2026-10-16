-- LST-09 for products: the product catalog gets the shared list pieces the other lists have:
-- the user's columns (list_preferences, LST-03) and saved views (saved_views, LST-04).
-- Both tables only gain the object type 'product'; their rows, grants and policies are
-- unchanged (own rows for columns; private / team / org for views, as before).
--
-- Everything else of the feature lives in the app: the advanced filter (LST-05), editing in the
-- cell (LST-06) and bulk actions (LST-07) write with the user's session, so the products policies
-- decide (catalog editors only, PRM-01 included), and the export goes through
-- log_list_export('product') as it already did (PRD-05).

alter table public.list_preferences drop constraint if exists list_preferences_object_type_check;
alter table public.list_preferences add constraint list_preferences_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'deal_board', 'product'));

alter table public.saved_views drop constraint if exists saved_views_object_type_check;
alter table public.saved_views add constraint saved_views_object_type_check
  check (object_type in ('lead', 'contact', 'company', 'deal', 'task', 'product'));

-- The list export keeps a plain choice value of a filter only when it is listed here (RVW-4); the
-- product catalog's filter (LST-05 on products) adds its kind, VAT kind and billing codes.
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
    'one_time', 'monthly', 'quarterly', 'yearly'
  ];
$$;

revoke all on function app.export_choice_values() from public, anon, authenticated;

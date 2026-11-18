-- =============================================================================
-- DOC-16: invoice provider log lines are removed after 12 months (INT-03's rule)
-- =============================================================================
-- PASTED BY HAND in the SQL Editor (the connector stops on a migration that holds a delete statement). Belongs to
-- _invoice_provider_events.sql, which makes public.invoice_provider_events and the nightly job
-- crm-invoice-provider-events-purge; that job calls app.purge_old_invoice_provider_events(), which does nothing until this
-- function exists. Safe to run twice.
--
-- app.invoice_provider_events_purge_rows(limit): removes log lines whose last_at is more than 12 months ago, at most `limit`
-- a run (0..10,000), oldest first, and the notice days older than 30 days; answers how many log lines it removed.
-- Security definer, search_path pinned, no client may call it.

create or replace function app.invoice_provider_events_purge_rows(p_limit integer) returns integer
language plpgsql security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.invoice_provider_events e
   where e.id in (select o.id from public.invoice_provider_events o
                   where o.last_at < now() - interval '12 months'
                   order by o.last_at
                   limit least(greatest(coalesce(p_limit, 0), 0), 10000));
  get diagnostics v_count = row_count;
  delete from app.invoice_provider_notice_days d where d.day < current_date - 30;
  return v_count;
end;
$$;
revoke all on function app.invoice_provider_events_purge_rows(integer) from public, anon, authenticated, service_role;

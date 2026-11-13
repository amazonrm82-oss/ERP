-- =============================================================================
-- 021273 ADM-03: carrying out a business's deletion (owner, 13 November 2026, answers (361) ב, (363) ב)
-- =============================================================================
-- Its own small file because it removes rows (the connector refuses a delete): the owner pastes it in the SQL Editor after
-- _org_deletion.sql, whose wrapper app.run_org_deletions() (pg_cron 'crm-org-deletions') calls this function once it exists.
-- The removal is 021193's (_org_delete_cancelled.sql, the owner's go-ahead of 9 November 2026) made a function:
-- * Refused (false, nothing happens) unless the business has a confirmed request that was not cancelled or carried out and
--   whose 30 days have passed.
-- * Every Storage object under the business's folder in record-files, org-logos and job-files is queued in app.orphan_files
--   first, then the organizations row goes and everything that hangs on it goes with it through the foreign keys (records,
--   settings, memberships, subscription, audit log, outbox, notifications, the app tables that carry its id). The guards that
--   keep documents, payments, number series, owners and kept files step aside in the business's own cascade (app.org_exists).
--   The normal triggers queue the files' and the logo's paths too; the nightly cleanup removes the objects.
-- * Its people: auth.users and public.profiles are never touched (answer (363) ב); only the membership rows go.
-- * Rows that carry its id without a foreign key are cleared by hand, as in 021193.
-- * Kept: app.platform_log, app.automation_rule_runs, and the request row in app.org_deletions (ids and times only).
-- * app.org_deletion_code_tries rows whose sent code is older than a day (the code lives an hour) are removed by
--   app.purge_old_org_deletion_code_tries, which app.run_org_deletions calls at the start of every run.
-- Safe to run twice.

create or replace function app.org_deletion_purge(p_org uuid) returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from app.org_deletions d
     where d.organization_id = p_org and d.confirmed_at is not null and d.cancelled_at is null and d.done_at is null
       and d.scheduled_for <= now()) then
    return false;
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_org) then
    return true;
  end if;

  -- no session setting steers a delete trigger here
  perform set_config('app.sample_removal', '', true);
  perform set_config('app.order_server', '', true);
  perform set_config('app.document_server', '', true);
  perform set_config('app.payment_server', '', true);
  perform set_config('app.quote_pdf_erase', '', true);
  perform set_config('app.order_pdf_erase', '', true);

  -- every object under the business's folder, also one no row points at
  begin
    insert into app.orphan_files (storage_path, bucket)
    select o.name, o.bucket_id from storage.objects o
     where o.bucket_id in ('record-files', 'org-logos', 'job-files') and o.name like p_org::text || '/%'
    on conflict do nothing;
  exception when insufficient_privilege then
    raise warning 'org_deletion_purge: cannot read storage.objects; only the paths the triggers queue were queued';
  end;

  -- rows that carry its id without a foreign key
  delete from app.booking_view_counts c
   where c.page_id in (select p.id from public.booking_pages p where p.organization_id = p_org);
  delete from app.business_card_view_counts c
   where c.card_id in (select b.id from public.business_cards b where b.organization_id = p_org);
  delete from app.quote_expiry_retry r
   where r.quote_id in (select q.id from public.quotes q where q.organization_id = p_org);
  delete from app.booking_requests r where r.organization_id = p_org;
  delete from app.booking_page_closures c where c.organization_id = p_org;

  -- the business and everything that hangs on it (cascade)
  delete from public.organizations o where o.id = p_org;
  return true;
end;
$$;
revoke all on function app.org_deletion_purge(uuid) from public, anon, authenticated, service_role;

-- the guess counters of codes older than a day (a code lives an hour); called by app.run_org_deletions
create or replace function app.purge_old_org_deletion_code_tries() returns integer
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from app.org_deletion_code_tries t where t.sent_at < now() - interval '1 day';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function app.purge_old_org_deletion_code_tries() from public, anon, authenticated, service_role;

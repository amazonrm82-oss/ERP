-- =============================================================================
-- Owner's go-ahead (9 November 2026, hard rule 3): remove the cancelled business a415bb9e-a965-4ad1-a7e0-85b22637e76f in full
-- (pasted by hand in the SQL Editor: it holds row removals)
-- =============================================================================
-- One DO block, so the whole file is one transaction: it does everything or nothing. Safe to run twice: the second run finds
-- nothing. It changes no schema object (no function, policy, grant, trigger or constraint), and the fresh build, where the
-- business does not exist, runs it as a no-op. No other business is named or reached.
--
-- * Refused (nothing happens) unless the organizations row is still status 'cancelled'.
-- * The organizations row goes, and every row that hangs on it goes with it through the foreign keys (ON DELETE CASCADE from
--   public.organizations, directly or through its records): records, settings, memberships, subscription, audit log, outbox,
--   notifications, and the app tables that carry its id. The guards that keep documents, payments, number series, owners and
--   kept files step aside in the business's own cascade (they ask app.org_exists, false once the row is gone), so no guard
--   is bypassed or changed here.
-- * Files and the logo: the normal triggers (files_after_delete, organizations_logo_orphans) put their paths in
--   app.orphan_files, and the nightly cleanup removes the Storage objects (on hosted the business has none).
-- * Its people: the Auth user and the profile stay (auth.* and public.profiles are never touched); only the membership row
--   goes with the business.
-- * A few app tables carry its id without a foreign key; they are cleared here by hand: app.booking_requests,
--   app.booking_page_closures, app.booking_view_counts / app.business_card_view_counts (by its pages and cards) and
--   app.quote_expiry_retry (by its quotes).
-- * Kept on purpose: app.platform_log (platform history, append-only by platform_log_permanent; no foreign key) and
--   app.automation_rule_runs (65,536 reused slots of the running transaction, no business data).

do $cleanup$
declare
  v_gone constant uuid := 'a415bb9e-a965-4ad1-a7e0-85b22637e76f';
  v_status text;
begin
  -- no session setting steers a delete trigger here: the settings the cascade's triggers read start empty
  perform set_config('app.sample_removal', '', true);
  perform set_config('app.order_server', '', true);
  perform set_config('app.document_server', '', true);
  perform set_config('app.payment_server', '', true);
  perform set_config('app.quote_pdf_erase', '', true);
  perform set_config('app.order_pdf_erase', '', true);

  select o.status into v_status from public.organizations o where o.id = v_gone;
  if not found then
    return;
  end if;
  if v_status is distinct from 'cancelled' then
    raise exception 'org delete: business % is %, not cancelled; nothing was done', v_gone, v_status;
  end if;

  -- rows that carry its id without a foreign key
  delete from app.booking_view_counts c
   where c.page_id in (select p.id from public.booking_pages p where p.organization_id = v_gone);
  delete from app.business_card_view_counts c
   where c.card_id in (select b.id from public.business_cards b where b.organization_id = v_gone);
  delete from app.quote_expiry_retry r
   where r.quote_id in (select q.id from public.quotes q where q.organization_id = v_gone);
  delete from app.booking_requests r where r.organization_id = v_gone;
  delete from app.booking_page_closures c where c.organization_id = v_gone;

  -- the business and everything that hangs on it (cascade); its file and logo paths reach app.orphan_files
  delete from public.organizations o where o.id = v_gone;
end;
$cleanup$;

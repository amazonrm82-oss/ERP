-- =============================================================================
-- ON HOLD (owner, 9 November 2026): reset of business e3bcb98c-2cd7-47f9-ab61-e0f233a66305. NOT a migration: it lives in
-- scripts/ops so that no build and no apply ever runs it. It is run only when the owner says so, pasted by hand in the SQL
-- Editor (it holds row removals). Its test (tests/db/316-org-reset-arizot.test.ts) runs it on fixture businesses.
-- =============================================================================
-- One DO block, so the whole file is one transaction: it either does everything or nothing. Safe to run twice: the second
-- run finds nothing to remove. It changes no schema object (no function, policy, grant, trigger or constraint).
--
-- Business e3bcb98c-2cd7-47f9-ab61-e0f233a66305: reset. Every record and everything about records is removed; the
--   business, its people and its settings stay. Every statement names the business. Records are removed with their normal
--   delete triggers (purge_links, files_after_delete, the detach triggers, the counters), children before parents, so no
--   set-null update touches a row that is about to go anyway. Deferred constraint triggers are fired before the end
--   (set constraints all immediate), then the business's notifications, outbox events and audit log go LAST, because
--   removing records writes new ones.
--   Server paths used, all transaction-local and naming this business: app.order_server = 'on' (orders_delete_guard lets
--   a numbered order go), app.quote_pdf_erase / app.order_pdf_erase = the business (files_keep_attached lets a quote's or
--   an order's PDF go). Two guards have no such path and are NOT bypassed:
--   * files_keep_attached for a confirmed file of an accounting document or a payment: if the business has one, the file
--     stops with an error and nothing at all is done (on hosted the business has no files).
--   * number_sequences_guard (the last number never goes back): the series are left as they are and a notice says so
--     (on hosted the business's one series has no number yet).
--
-- Business 7684fff2-200c-4be3-9276-b41cf53cd7e6 (and every other) is named by no statement; none reaches another business.
--
-- Per-table decisions for the reset. Tables in public and app with organization_id:
--   REMOVED (records and what hangs on them):
--     public.punch_card_uses, punch_cards                    punch cards and their used entries
--     public.payment_refunds, payment_allocations, opening_credit_allocations, payment_promise_documents, payment_promises
--     public.payment_credit_companies, customer_credit_totals, debt_document_customers, customer_debt_totals (kept sums)
--     public.accounting_document_lines, accounting_documents, payments
--     public.order_decisions, order_payment_steps, order_lines, orders
--     public.quote_decisions, quote_views, quote_payment_steps, quote_lines, quotes
--     public.files (every file but a content library file; their paths go to app.orphan_files)
--     public.task_checklist_items, tasks, meeting_participants, meetings (blocked time included)
--     public.messages, consents, contact_channels, contact_companies, contact_relations, deal_contacts, deal_line_costs,
--            deal_lines, customer_holds, record_followers, segment_members, segments, form_submissions, privacy_requests,
--            activities, leads, deals, contacts, companies
--     public.automation_runs (run log of records), background_requests (background import/export; their job files are
--            queued by background_requests_deleted), import_jobs (import history), campaign_costs (monthly spend entries)
--     public.notifications, outbox_events, audit_log (last)
--     app.absence_waiting_leads, activity_audit_links, activity_mentions, booking_manage_links, booking_requests,
--         collection_reminders_sent, collection_task_closes, consent_pending_address, customer_purchase_facts,
--         intake_callback_tasks, jobs (the business's queued jobs: messages and background jobs about its records),
--         lead_callback_requests, lead_response_checks, lead_retention_keeps, lead_retention_round_leads,
--         lead_retention_rounds, meeting_order_draft_notices, meeting_order_drafts, meeting_reminders_sent,
--         meta_lead_arrivals, opening_credit_companies, order_links, order_pdf_download_counts, pending_erasures,
--         punch_card_alerts_sent, punch_card_customer_notices, punch_card_retries, quick_sale_lines,
--         quote_link_view_counts, quote_links, quote_pdf_download_counts, quote_pdf_remakes, quote_question_counts,
--         recipient_pdf_credits, rotation_waiting_leads, sample_records, statement_links
--     app.quote_expiry_retry (no organization_id; by the business's quotes)
--   KEPT (the business, its people, its settings, counters and platform history):
--     public.memberships, teams, team_members, invitations, member_permissions, member_leaves, list_preferences,
--            saved_views, subscriptions, support_access_grants, support_requests, plan_waitlist, org_usage (its record
--            count falls with the removals, through count_record)
--     public.activity_types, automations, booking_pages, business_cards, card_layouts, checklist_templates,
--            completeness_settings, consent_blocklist (do-not-contact hashes: the safe side), contact_relation_types,
--            conversion_field_maps, customer_status_settings, deal_contact_roles, deal_loss_reasons, disqualify_reasons,
--            field_definitions, forms (the business card's own form included), goals, integrations, lead_distribution_settings,
--            lead_response_settings, lead_routing_rules, lead_score_rules, lead_sources, lead_statuses, library_categories,
--            library_items, meeting_types, message_templates, meta_lead_forms, number_sequences, org_bank_details,
--            org_calendar_settings, org_document_settings, org_message_settings, org_modules, org_privacy_settings,
--            org_sending_pauses, org_terms, pipelines, stages, price_lists, price_list_lines, product_bundle_items,
--            product_categories, product_costs, product_units, products (a product an import made loses only its
--            import_job_id, by the foreign key), punch_card_alert_settings, qr_codes, quote_designs, quote_templates,
--            quote_template_lines, record_type_options, site_widgets, tags, whatsapp_templates
--     app.automation_rule_runs, automation_run_months, automation_scan_cursors, booking_page_closures, calendar_feeds,
--         cleanup_suggestion_weeks, collection_reminder_turns, consent_blocklist_pending, dormant_backfills,
--         integration_secrets, job_cancel_counts, lead_retention_settings, lead_rotation_clock, lead_rotation_passes,
--         lead_score_queue, message_cap_holds, message_cap_notices, message_refusal_notices, message_send_rate,
--         message_usage_days, meta_lead_notice_days, org_activation, org_suspensions, pdf_months, platform_assignments,
--         platform_log, privacy_request_counts, privacy_request_links, privacy_request_notice_days, punch_card_alert_orgs,
--         punch_card_alert_turns, punch_card_template_seeds, qr_external_blocks, schedule_business_turns,
--         subprocessor_notices, support_request_notes, support_request_reads, support_sessions, trial_end_transitions
--   Per person, never touched: auth.*, public.profiles, notification_settings, push_subscriptions, app.agreement_signatures,
--   app.mfa_recovery_codes and the rest of the per-user tables.

do $cleanup$
declare
  v_reset constant uuid := 'e3bcb98c-2cd7-47f9-ab61-e0f233a66305';
  v_kept integer;
begin
  -- no session setting steers a trigger here: every setting a delete trigger reads starts empty for this transaction
  perform set_config('app.sample_removal', '', true);
  perform set_config('app.bulk_transfer', '', true);
  perform set_config('app.automation_running', '', true);
  perform set_config('app.intake', '', true);
  perform set_config('app.order_server', '', true);
  perform set_config('app.document_server', '', true);
  perform set_config('app.payment_server', '', true);
  perform set_config('app.quote_pdf_erase', '', true);
  perform set_config('app.order_pdf_erase', '', true);
  perform set_config('app.condition_cleanup', '', true);

  if not exists (select 1 from public.organizations o where o.id = v_reset) then
    return;
  end if;

  -- a guard with no server path: stop before anything changes
  if exists (select 1 from public.files f
              where f.organization_id = v_reset and f.unconfirmed_since is null
                and (f.accounting_document_id is not null or f.payment_id is not null)) then
    raise exception 'org reset: business % has a kept file of a document or a payment (files_keep_attached); nothing was done', v_reset;
  end if;

  -- the PDFs of its quotes and orders may go (files_keep_attached's erasure path, this business only)
  perform set_config('app.quote_pdf_erase', v_reset::text, true);
  perform set_config('app.order_pdf_erase', v_reset::text, true);

  -- punch cards first: they point at document lines, deal lines, payments, meetings and contacts
  delete from public.punch_card_uses x where x.organization_id = v_reset;
  delete from public.punch_cards x where x.organization_id = v_reset;

  -- money: what points at documents and payments, then the documents and payments
  delete from public.payment_refunds x where x.organization_id = v_reset;
  delete from public.payment_allocations x where x.organization_id = v_reset;
  delete from public.opening_credit_allocations x where x.organization_id = v_reset;
  delete from public.payment_promise_documents x where x.organization_id = v_reset;
  delete from public.payment_promises x where x.organization_id = v_reset;
  delete from public.payment_credit_companies x where x.organization_id = v_reset;
  delete from public.customer_credit_totals x where x.organization_id = v_reset;
  delete from public.debt_document_customers x where x.organization_id = v_reset;
  delete from public.customer_debt_totals x where x.organization_id = v_reset;
  delete from public.accounting_document_lines x where x.organization_id = v_reset;
  delete from public.accounting_documents x where x.organization_id = v_reset;
  delete from public.payments x where x.organization_id = v_reset;

  -- orders (a numbered order goes only on the server path)
  perform set_config('app.order_server', 'on', true);
  delete from public.order_decisions x where x.organization_id = v_reset;
  delete from public.order_payment_steps x where x.organization_id = v_reset;
  delete from public.order_lines x where x.organization_id = v_reset;
  delete from public.orders x where x.organization_id = v_reset;
  perform set_config('app.order_server', '', true);

  -- quotes (their steps go in the quote's own cascade, which quote_payment_steps_check never refuses)
  delete from app.quote_expiry_retry r
   where r.quote_id in (select q.id from public.quotes q where q.organization_id = v_reset);
  delete from public.quote_decisions x where x.organization_id = v_reset;
  delete from public.quote_views x where x.organization_id = v_reset;
  delete from public.quote_lines x where x.organization_id = v_reset;
  delete from public.quotes x where x.organization_id = v_reset;

  -- files of records, notes and fields (a content library file stays with its item)
  delete from public.files x where x.organization_id = v_reset and x.library_item_id is null;

  -- tasks and meetings
  delete from public.task_checklist_items x where x.organization_id = v_reset;
  delete from public.tasks x where x.organization_id = v_reset;
  delete from public.meeting_participants x where x.organization_id = v_reset;
  delete from public.meetings x where x.organization_id = v_reset;

  -- what hangs on the records
  delete from public.messages x where x.organization_id = v_reset;
  delete from public.consents x where x.organization_id = v_reset;
  delete from public.contact_channels x where x.organization_id = v_reset;
  delete from public.contact_companies x where x.organization_id = v_reset;
  delete from public.contact_relations x where x.organization_id = v_reset;
  delete from public.deal_contacts x where x.organization_id = v_reset;
  delete from public.deal_line_costs x where x.organization_id = v_reset;
  delete from public.deal_lines x where x.organization_id = v_reset;
  delete from public.customer_holds x where x.organization_id = v_reset;
  delete from public.record_followers x where x.organization_id = v_reset;
  delete from public.segment_members x where x.organization_id = v_reset;
  delete from public.segments x where x.organization_id = v_reset;
  delete from public.form_submissions x where x.organization_id = v_reset;
  delete from public.privacy_requests x where x.organization_id = v_reset;
  delete from public.activities x where x.organization_id = v_reset;

  -- the records: leads point at deals, contacts and companies; deals at contacts and companies; contacts at companies
  delete from public.leads x where x.organization_id = v_reset;
  delete from public.deals x where x.organization_id = v_reset;
  delete from public.contacts x where x.organization_id = v_reset;
  delete from public.companies x where x.organization_id = v_reset;

  -- run logs, background jobs, import history, spend entries
  delete from public.automation_runs x where x.organization_id = v_reset;
  delete from public.background_requests x where x.organization_id = v_reset;
  delete from public.import_jobs x where x.organization_id = v_reset;
  delete from public.campaign_costs x where x.organization_id = v_reset;

  -- deferred constraint triggers (kept sums, customer facts) run now, so what they write is removed below
  set constraints all immediate;

  -- app tables about records (most already went with their records; these catch the rest)
  delete from app.absence_waiting_leads x where x.organization_id = v_reset;
  delete from app.activity_mentions x where x.organization_id = v_reset;
  delete from app.booking_manage_links x where x.organization_id = v_reset;
  delete from app.booking_requests x where x.organization_id = v_reset;
  delete from app.collection_reminders_sent x where x.organization_id = v_reset;
  delete from app.collection_task_closes x where x.organization_id = v_reset;
  delete from app.consent_pending_address x where x.organization_id = v_reset;
  delete from app.customer_purchase_facts x where x.organization_id = v_reset;
  delete from app.intake_callback_tasks x where x.organization_id = v_reset;
  delete from app.jobs x where x.organization_id = v_reset;
  delete from app.lead_callback_requests x where x.organization_id = v_reset;
  delete from app.lead_response_checks x where x.organization_id = v_reset;
  delete from app.lead_retention_keeps x where x.organization_id = v_reset;
  delete from app.lead_retention_round_leads x where x.organization_id = v_reset;
  delete from app.lead_retention_rounds x where x.organization_id = v_reset;
  delete from app.meeting_order_draft_notices x where x.organization_id = v_reset;
  delete from app.meeting_order_drafts x where x.organization_id = v_reset;
  delete from app.meeting_reminders_sent x where x.organization_id = v_reset;
  delete from app.meta_lead_arrivals x where x.organization_id = v_reset;
  delete from app.opening_credit_companies x where x.organization_id = v_reset;
  delete from app.order_links x where x.organization_id = v_reset;
  delete from app.order_pdf_download_counts x where x.organization_id = v_reset;
  delete from app.pending_erasures x where x.organization_id = v_reset;
  delete from app.punch_card_alerts_sent x where x.organization_id = v_reset;
  delete from app.punch_card_customer_notices x where x.organization_id = v_reset;
  delete from app.punch_card_retries x where x.organization_id = v_reset;
  delete from app.quick_sale_lines x where x.organization_id = v_reset;
  delete from app.quote_link_view_counts x where x.organization_id = v_reset;
  delete from app.quote_links x where x.organization_id = v_reset;
  delete from app.quote_pdf_download_counts x where x.organization_id = v_reset;
  delete from app.quote_pdf_remakes x where x.organization_id = v_reset;
  delete from app.quote_question_counts x where x.organization_id = v_reset;
  delete from app.recipient_pdf_credits x where x.organization_id = v_reset;
  delete from app.rotation_waiting_leads x where x.organization_id = v_reset;
  delete from app.sample_records x where x.organization_id = v_reset;
  delete from app.statement_links x where x.organization_id = v_reset;

  -- last: what the removals above wrote
  delete from public.notifications x where x.organization_id = v_reset;
  delete from public.outbox_events x where x.organization_id = v_reset;
  delete from app.activity_audit_links x where x.organization_id = v_reset;
  delete from public.audit_log x where x.organization_id = v_reset;

  perform set_config('app.quote_pdf_erase', '', true);
  perform set_config('app.order_pdf_erase', '', true);

  -- number series: the last number never goes back (number_sequences_guard), so they stay as they are
  select count(*) into v_kept from public.number_sequences s where s.organization_id = v_reset and s.last_number is not null;
  if v_kept > 0 then
    raise notice 'org reset: % number series of business % keep their last number (number_sequences_guard)', v_kept, v_reset;
  end if;
end;
$cleanup$;

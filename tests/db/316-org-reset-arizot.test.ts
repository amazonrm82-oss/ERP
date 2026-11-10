import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupPrefixes,
  exists,
  filePaths,
  keptQuotePdf,
  orphanPaths,
  personExtras,
  personRows,
  rowsOf,
  seed,
  snapshot,
  storageFor,
  verifiedFactors,
  type Snapshot,
} from "./org-cleanup-fixture";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

/**
 * supabase/migrations/20261006021195_org_reset_arizot.sql (owner's go-ahead, 9 November 2026; pasted by hand):
 * the reset of business e3bcb98c-… removes every record and what hangs on records, and keeps the business, its people and
 * its settings; no other business changes. The fixture businesses get random ids, so the script runs here with its one
 * hard-coded id replaced by the fixture's id: the same text otherwise. The script as committed is also run unchanged, where
 * it finds no such business and must change nothing.
 */

const SQL = readFileSync(path.join(__dirname, "../../supabase/migrations/20261006021195_org_reset_arizot.sql"), "utf8");
const RESET_ID = "e3bcb98c-2cd7-47f9-ab61-e0f233a66305";
const runFor = (reset: string) => SQL.replaceAll(RESET_ID, reset);

// The reset keeps exactly these tables of the business (the script's KEPT list); every other table with organization_id
// must be empty for it afterwards (public.files keeps only the content library's files), so a table nobody classified fails.
const KEPT = new Set([
  "public.memberships", "public.teams", "public.team_members", "public.invitations", "public.member_permissions",
  "public.member_leaves", "public.list_preferences", "public.saved_views", "public.subscriptions", "public.support_access_grants",
  "public.support_requests", "public.plan_waitlist", "public.org_usage",
  "public.activity_types", "public.automations", "public.booking_pages", "public.business_cards", "public.card_layouts",
  "public.checklist_templates", "public.completeness_settings", "public.consent_blocklist", "public.contact_relation_types",
  "public.conversion_field_maps", "public.customer_status_settings", "public.deal_contact_roles", "public.deal_loss_reasons",
  "public.disqualify_reasons", "public.document_templates", "public.field_definitions", "public.forms", "public.goals", "public.integrations",
  "public.lead_distribution_settings", "public.lead_response_settings", "public.lead_routing_rules", "public.lead_score_rules",
  "public.lead_sources", "public.lead_statuses", "public.library_categories", "public.library_items", "public.meeting_types",
  "public.message_templates", "public.meta_lead_forms", "public.number_sequences", "public.org_bank_details",
  "public.org_calendar_settings", "public.org_document_settings", "public.org_message_settings", "public.org_modules",
  "public.org_privacy_settings", "public.org_sending_pauses", "public.org_terms", "public.pipelines", "public.stages",
  "public.price_lists", "public.price_list_lines", "public.product_bundle_items", "public.product_categories",
  "public.product_costs", "public.product_units", "public.products", "public.punch_card_alert_settings", "public.qr_codes",
  "public.quote_designs", "public.quote_templates", "public.quote_template_lines", "public.record_type_options",
  "public.site_widgets", "public.tags", "public.whatsapp_templates",
  "app.automation_rule_runs", "app.automation_run_months", "app.automation_scan_cursors", "app.booking_page_closures",
  "app.calendar_feeds", "app.cleanup_suggestion_weeks", "app.collection_reminder_turns", "app.consent_blocklist_pending",
  "app.dormant_backfills", "app.integration_secrets", "app.job_cancel_counts", "app.lead_retention_settings",
  "app.lead_rotation_clock", "app.lead_rotation_passes", "app.lead_score_queue", "app.message_cap_holds",
  "app.message_cap_notices", "app.message_refusal_notices", "app.message_send_rate", "app.message_usage_days",
  "app.meta_lead_notice_days", "app.org_activation", "app.org_suspensions", "app.pdf_months", "app.platform_assignments",
  "app.platform_log", "app.privacy_request_counts", "app.privacy_request_links", "app.privacy_request_notice_days",
  "app.punch_card_alert_orgs", "app.punch_card_alert_turns", "app.punch_card_template_seeds", "app.qr_external_blocks",
  "app.schedule_business_turns", "app.subprocessor_notices", "app.support_request_notes", "app.support_request_reads",
  "app.support_sessions", "app.trial_end_transitions",
]);
// kept tables whose content the reset changes by design: the record counter follows the removed records
const KEPT_CHANGING = new Set(["public.org_usage"]);

afterAll(closePool);

describe("resetting a business (script on hold, owner 9 November 2026)", () => {
  let owner2: { id: string; email: string };
  let member2: { id: string; email: string };
  let owner3: { id: string; email: string };
  let reset: string;
  let other: string;
  let logo2: string;
  let otherBefore: Snapshot;
  let resetBefore: Snapshot;
  let peopleBefore: Snapshot;
  let files2: string[];
  let library2: string[];
  const prefixes: string[] = [];

  afterAll(() => cleanupPrefixes(prefixes));

  beforeAll(async () => {
    owner2 = await createUser("reset-owner");
    owner3 = await createUser("other-owner");
    reset = await createOrg(owner2.id, "עסק לאיפוס");
    other = await createOrg(owner3.id, "עסק אחר");
    prefixes.push(`${reset}/%`, `${other}/%`);
    await seed(owner2, reset, "2");
    await seed(owner3, other, "3");

    // the business's people: a second member with every per-person setting
    member2 = await addMember(reset, owner2.id, "member", "reset-member");
    await asUser(owner2.id, (q) => q("select public.set_member_permissions($1, $2, '{export}')", [reset, member2.id]));
    await asUser(member2.id, async (q) => {
      await q("select public.calendar_feed_create($1)", [reset]);
      await q("select public.set_notification_settings($1, $2)", [["follow"], []]);
      await q("insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/reset', 'k', 'a')");
      await q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'contact', '[{\"key\": \"email\"}]')", [reset]);
      await q("insert into public.saved_views (organization_id, object_type, name, owner_id) values ($1, 'lead', 'שלי', $2)", [reset, member2.id]);
    });
    await asAdmin((q) =>
      q(
        "insert into public.team_members (organization_id, team_id, user_id) select $1, t.id, $2 from public.teams t where t.organization_id = $1 order by t.id limit 1",
        [reset, member2.id],
      ),
    );
    await personExtras([owner2.id, member2.id]);
    for (const org of [reset, other]) await keptQuotePdf(org);
    logo2 = await storageFor(owner2, reset);
    await storageFor(owner3, other);
    await verifiedFactors([owner2.id, member2.id]);

    files2 = await filePaths(reset, "library_item_id is null");
    library2 = await filePaths(reset, "library_item_id is not null");
    otherBefore = await snapshot(other);
    resetBefore = await snapshot(reset);
    peopleBefore = await personRows([owner2.id, member2.id]);
  });

  it("the fixture holds data in the tables the reset touches", () => {
    for (const t of [
      "public.leads", "public.contacts", "public.companies", "public.deals", "public.tasks", "public.meetings", "public.activities",
      "public.files", "public.form_submissions", "public.quotes", "public.quote_lines", "public.orders", "public.accounting_documents",
      "public.payments", "public.payment_allocations", "public.payment_refunds", "public.punch_cards", "public.punch_card_uses",
      "public.messages", "public.consents", "public.record_followers", "public.segments", "public.segment_members", "public.import_jobs",
      "public.notifications", "public.audit_log", "public.outbox_events", "public.privacy_requests", "public.background_requests",
      "public.contact_companies", "public.contact_relations", "public.deal_lines", "public.customer_holds", "public.payment_promises",
      "public.opening_credit_allocations", "public.campaign_costs", "public.task_checklist_items",
    ]) {
      expect(rowsOf(resetBefore, t), t).toBeGreaterThan(0);
    }
    expect(files2.length).toBeGreaterThan(2);
    expect(library2.length).toBe(1);
  });

  it("the script as committed finds no such business and changes nothing", async () => {
    await asAdmin((q) => q(SQL));
    expect(await snapshot(other)).toEqual(otherBefore);
    expect(await snapshot(reset)).toEqual(resetBefore);
  });

  it("refuses a reset while a document's or a payment's kept file exists (files_keep_attached has no server path)", async () => {
    const owner4 = await createUser("kept-file-owner");
    const org4 = await createOrg(owner4.id, "עסק עם קובץ שמור");
    prefixes.push(`${org4}/%`);
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"documents\": true}' where organization_id = $1", [org4]),
    );
    const lead = await insertLead(owner4.id, org4);
    await asUser(owner4.id, async (q) => {
      const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'לקוח') returning id", [org4])).rows[0].id;
      const doc = (
        await q<{ id: string }>(
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'K-1', 100) returning id",
          [org4, contact],
        )
      ).rows[0].id;
      await q("insert into public.files (organization_id, accounting_document_id, name, mime_type, size_bytes) values ($1, $2, 'קבלה.pdf', 'application/pdf', 100)", [
        org4,
        doc,
      ]);
    });
    await asAdmin((q) => q("update public.files set unconfirmed_since = null where organization_id = $1", [org4]));
    const before = await snapshot(org4);
    await expect(asAdmin((q) => q(runFor(org4)))).rejects.toThrow(/kept file of a document or a payment/);
    expect(await snapshot(org4)).toEqual(before);
    expect(await exists("select 1 from public.leads where id = $1", [lead])).toBe(true);
  });

  it("refuses a reset while the business holds an opt-out (consents survive a purge on purpose)", async () => {
    const owner5 = await createUser("opt-out-owner");
    const org5 = await createOrg(owner5.id, "עסק עם סירוב");
    prefixes.push(`${org5}/%`);
    const lead = await insertLead(owner5.id, org5);
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'denied', 'manual', 'בשיחה')", [org5, lead]),
    );
    const before = await snapshot(org5);
    await expect(asAdmin((q) => q(runFor(org5)))).rejects.toThrow(/opt-out or a do-not-contact/);
    expect(await snapshot(org5)).toEqual(before);
  });

  describe("after the run", () => {
    let otherAfter: Snapshot;
    let resetAfter: Snapshot;

    beforeAll(async () => {
      await asAdmin((q) => q(runFor(reset)));
      otherAfter = await snapshot(other);
      resetAfter = await snapshot(reset);
    });

    it("the business holds no record data, and every kept table is unchanged", async () => {
      expect(await exists("select 1 from public.organizations where id = $1", [reset])).toBe(true);
      for (const [t, s] of Object.entries(resetAfter)) {
        if (t === "public.files") {
          // only the content library's files stay, with their items
          expect(rowsOf(resetAfter, t), t).toBe(library2.length);
        } else if (!KEPT.has(t)) {
          expect(s, `${t} should be empty`).toBe("0:");
        } else if (!KEPT_CHANGING.has(t)) {
          expect(s, `${t} should be unchanged`).toBe(resetBefore[t]);
        }
      }
      // every name in the kept list is a real table with organization_id
      expect([...KEPT].filter((t) => !(t in resetAfter))).toEqual([]);
      expect(rowsOf(resetAfter, "public.memberships")).toBe(3);
      expect(rowsOf(resetAfter, "public.forms")).toBeGreaterThan(0);
      expect(rowsOf(resetAfter, "public.products")).toBeGreaterThan(0);
      const usage = await asAdmin(async (q) => (await q<{ n: string }>("select records_count::text as n from public.org_usage where organization_id = $1", [reset])).rows[0].n);
      expect(usage).toBe("0");
    });

    it("the business's people are untouched, byte for byte", async () => {
      const after = await personRows([owner2.id, member2.id]);
      expect(after).toEqual(peopleBefore);
      for (const t of [
        "auth.users", "auth.sessions", "auth.mfa_factors", "public.profiles", "public.memberships", "public.team_members",
        "app.calendar_feeds", "app.agreement_signatures", "app.mfa_recovery_codes", "public.push_subscriptions",
        "public.notification_settings", "public.saved_views", "public.list_preferences", "public.member_permissions",
        "public.member_leaves", "public.booking_pages", "public.business_cards",
      ]) {
        expect(rowsOf(after, t), t).toBeGreaterThan(0);
      }
    });

    it("every other business is unchanged, byte for byte", () => {
      expect(otherAfter).toEqual(otherBefore);
    });

    it("the removed files' paths wait for the nightly cleanup; library files and the logo stay", async () => {
      const queued = await orphanPaths(reset);
      for (const p of files2) expect(queued, p).toContain(p);
      for (const p of library2) expect(queued).not.toContain(p);
      expect(queued).not.toContain(logo2);
      expect(await orphanPaths(other)).toEqual([]);
      const logo = await asAdmin(async (q) => (await q<{ l: string }>("select logo_path as l from public.organizations where id = $1", [reset])).rows[0].l);
      expect(logo).toBe(logo2);
    });

    it("running the script a second time changes nothing", async () => {
      const queued = await orphanPaths(reset);
      await asAdmin((q) => q(runFor(reset)));
      expect(await snapshot(other)).toEqual(otherAfter);
      expect(await snapshot(reset)).toEqual(resetAfter);
      expect(await orphanPaths(reset)).toEqual(queued);
      expect(await personRows([owner2.id, member2.id])).toEqual(peopleBefore);
    });
  });
});

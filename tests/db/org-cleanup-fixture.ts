import { randomUUID } from "node:crypto";
import { asAdmin, asService, asUser, createUser, defaultLeadStatus, defaultPipeline, insertLead, type Query } from "./helpers";

/**
 * Fixtures shared by tests 315 (removing a cancelled business) and 316 (the business reset kept in scripts/ops):
 * data in nearly every table of one business (the seed of test 02), snapshots of a business's rows per table, and the
 * per-person rows of given users, each as a row count and an md5 of the full content.
 */

export type Snapshot = Record<string, string>;

export async function orgTables(q: Query): Promise<string[]> {
  const res = await q<{ t: string }>(
    `select n.nspname || '.' || c.relname as t
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'organization_id' and not a.attisdropped
      where n.nspname in ('public', 'app') and c.relkind in ('r', 'p') order by 1`,
  );
  return res.rows.map((r) => r.t);
}

/** Per table: the number of the business's rows and an md5 of their full content. */
export async function snapshot(org: string): Promise<Record<string, string>> {
  return asAdmin(async (q) => {
    const out: Record<string, string> = {};
    for (const t of await orgTables(q)) {
      const res = await q<{ s: string }>(
        `select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as s from ${t} x where x.organization_id = $1`,
        [org],
      );
      out[t] = res.rows[0].s;
    }
    return out;
  });
}

export const rowsOf = (s: Record<string, string>, t: string) => Number(s[t].split(":")[0]);

/** Per-person rows of the given users, byte for byte. */
export async function personRows(users: string[]): Promise<Record<string, string>> {
  const tables: [string, string][] = [
    ["auth.users", "id"],
    ["auth.sessions", "user_id"],
    ["auth.mfa_factors", "user_id"],
    ["public.profiles", "id"],
    ["public.notification_settings", "user_id"],
    ["public.push_subscriptions", "user_id"],
    ["public.memberships", "user_id"],
    ["public.team_members", "user_id"],
    ["public.member_permissions", "user_id"],
    ["public.member_leaves", "user_id"],
    ["public.list_preferences", "user_id"],
    ["public.saved_views", "owner_id"],
    ["public.booking_pages", "user_id"],
    ["public.business_cards", "user_id"],
    ["app.calendar_feeds", "user_id"],
    ["app.agreement_signatures", "user_id"],
    ["app.mfa_recovery_codes", "user_id"],
  ];
  return asAdmin(async (q) => {
    const out: Record<string, string> = {};
    for (const [t, col] of tables) {
      const res = await q<{ s: string }>(
        `select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as s from ${t} x where x.${col} = any($1::uuid[])`,
        [users],
      );
      out[t] = res.rows[0].s;
    }
    return out;
  });
}

/** Data in nearly every table, the seed of test 02 (tenant isolation) for one business. */
export async function seed(owner: { id: string }, org: string, tag: string): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
    const pipe = await defaultPipeline(org);
    ids.pipelineA = pipe.pipelineId;
    ids.stageA = pipe.stages[0].id;
    ids.statusA = await defaultLeadStatus(org);
    ids.leadA = await insertLead(owner.id, org, { phone: "050-1234567", company_name: "חברה א" });

    await asUser(owner.id, async (q) => {
      ids.companyA = (
        await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברת סוד') returning id", [org])
      ).rows[0].id;
      ids.contactA = (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'דנה', $2) returning id",
          [org, ids.companyA],
        )
      ).rows[0].id;
      ids.dealA = (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot) values ($1, 'עסקה סודית', $2, $3, 500000) returning id",
          [org, ids.pipelineA, ids.stageA],
        )
      ).rows[0].id;
      ids.taskA = (
        await q<{ id: string }>(
          "insert into public.tasks (organization_id, title, lead_id) values ($1, 'לחזור ללקוח', $2) returning id",
          [org, ids.leadA],
        )
      ).rows[0].id;
      ids.activityA = (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'הערה פנימית', $2) returning id",
          [org, ids.leadA],
        )
      ).rows[0].id;
      await q(
        "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'הצעה.pdf', 'application/pdf', 1000)",
        [org, ids.leadA],
      );
      ids.tagA = (
        await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'VIP') returning id", [org])
      ).rows[0].id;
      ids.leadFieldA = (
        await q<{ id: string }>(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'budget_range', 'טווח תקציב', 'text') returning id",
          [org],
        )
      ).rows[0].id;
      ids.contactFieldA = (
        await q<{ id: string }>(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'contact', 'budget_note', 'הערת תקציב', 'text') returning id",
          [org],
        )
      ).rows[0].id;
      // LEAD-06
      await q(
        "insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, target_field_id) values ($1, $2, 'contact', $3)",
        [org, ids.leadFieldA, ids.contactFieldA],
      );
      await q("insert into public.teams (organization_id, name) values ($1, 'מכירות')", [org]);
      await q("select public.create_invitation($1, 'someone@example.test')", [org]);
      const form = (
        await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס אתר') returning id, token", [org])
      ).rows[0];
      ids.formA = form.id;
      ids.formTokenA = form.token;
      ids.automationA = (
        await q<{ id: string }>(
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'כלל', 'lead', 'created', '[{\"type\":\"notify\"}]') returning id",
          [org],
        )
      ).rows[0].id;
      await q("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'leads.csv', 'skip')", [org]);
      await q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]);
      await q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'lead', '[{\"key\": \"phone\"}]')", [org]);
      await q("insert into public.record_followers (organization_id, lead_id) values ($1, $2)", [org, ids.leadA]);
      await q("insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{6}')", [org]);
      await q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]);
      // QUO-05
      await q("insert into public.quote_designs (organization_id, header_text) values ($1, 'כותרת של א')", [org]);
      // FLD-10
      await q("insert into public.org_terms (organization_id, contact_term) values ($1, 'patient')", [org]);
      // LEAD-08
      await q("insert into public.org_modules (organization_id, leads_enabled) values ($1, false)", [org]);
      // CON-11
      await q("insert into public.customer_status_settings (organization_id, dormant_months, former_months) values ($1, 4, 10)", [org]);
      // PKG-03
      await q("insert into public.punch_card_alert_settings (organization_id, low_entries, expiry_days) values ($1, 3, 10)", [org]);
      // HEB-09
      await q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [org]);
      // MSG-06
      await q("insert into public.org_message_settings (organization_id, window_from) values ($1, '09:00')", [org]);
      // PRK-06
      await q("insert into public.org_privacy_settings (organization_id, privacy_officer_id) values ($1, $2)", [org, owner.id]);
      await q("insert into public.lead_response_settings (organization_id, target_minutes) values ($1, 30)", [org]);
      await q("insert into public.number_sequences (organization_id, kind, prefix) values ($1, 'quote', 'Q-')", [org]);
      await q("insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account) values ($1, 'בנק', '800', '1234567')", [org]);
      // USR-12
      await q("insert into public.support_requests (organization_id, category, subject, message) values ($1, 'question', 'שאלה', 'איך מייבאים?')", [org]);
      // IMP-04
      await q("insert into public.background_requests (organization_id, kind) values ($1, 'export')", [org]);
      ids.meetingA = (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'פגישת היכרות', now() + interval '1 day', now() + interval '1 day 1 hour', $2) returning id",
          [org, ids.leadA],
        )
      ).rows[0].id;
      await q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [org, ids.meetingA, owner.id]);
      // a second meeting with nobody on it yet: the target of the forged participant insert below
      ids.meetingA2 = (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'ישיבת צוות', now() + interval '2 days', now() + interval '2 days 1 hour') returning id",
          [org],
        )
      ).rows[0].id;
      await q("insert into public.disqualify_reasons (organization_id, name) values ($1, 'סיבה של א')", [org]);
      await q("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'סיבת הפסד של א')", [org]);
      await q("insert into public.deal_contact_roles (organization_id, name) values ($1, 'תפקיד של א')", [org]);
      await q("insert into public.goals (organization_id, scope, period, period_start, metric, target) values ($1, 'org', 'month', '2026-10-01', 'won_amount', 100000)", [org]);
      await q("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'contact', 'סוג של א')", [org]);
      await q("insert into public.contact_channels (organization_id, contact_id, kind, label, value) values ($1, $2, 'phone', 'other', '052-7000001')", [org, ids.contactA]);
      // CON-05: contactA's company is its primary link (by trigger); a second company as a further one
      ids.company2A = (await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברה שנייה של א') returning id", [org])).rows[0].id;
      await q("insert into public.contact_companies (organization_id, contact_id, company_id, title) values ($1, $2, $3, 'יועצת')", [org, ids.contactA, ids.company2A]);
      // CON-06: a relation between two of A's contacts (a seeded type)
      ids.contact2A = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'בת זוג של א') returning id", [org])).rows[0].id;
      ids.parentTypeA = (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'parent'", [org])).rows[0].id;
      await q(
        "insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) select $1, $2, $3, t.id from public.contact_relation_types t where t.organization_id = $1 and t.key = 'spouse'",
        [org, ids.contactA, ids.contact2A],
      );
      // CON-06: a lead of A referred A's second contact
      ids.referralTypeA = (await q<{ id: string }>("select id from public.contact_relation_types where organization_id = $1 and key = 'referral'", [org])).rows[0].id;
      await q("insert into public.contact_relations (organization_id, lead_id, related_contact_id, type_id) values ($1, $2, $3, $4)", [
        org,
        ids.leadA,
        ids.contact2A,
        ids.referralTypeA,
      ]);
      await q("insert into public.plan_waitlist (organization_id, plan_key) values ($1, 'business')", [org]);
      // TASK-06: a step in A's task (the templates are seeded for every new organization)
      await q("insert into public.task_checklist_items (organization_id, task_id, title) values ($1, $2, 'שלב של א')", [org, ids.taskA]);
      // CAL-10: a booking page of a's own (off: a has no working hours, and a page without hours cannot be on)
      await q(
        "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, is_active) select $1, $2, 'דף של א', t.id, false from public.meeting_types t where t.organization_id = $1 order by t.position limit 1",
        [org, owner.id],
      );
      // SEG-01: a static segment of A with A's lead in it
      ids.segmentA = (
        await q<{ id: string }>("insert into public.segments (organization_id, object_type, kind, name) values ($1, 'lead', 'static', 'סגמנט של א') returning id", [org])
      ).rows[0].id;
      await q("insert into public.segment_members (organization_id, segment_id, lead_id) values ($1, $2, $3)", [org, ids.segmentA, ids.leadA]);
      // LIB-01: a link item and a file item of A, with the file item's file (the categories are seeded)
      ids.libraryCategoryA = (await q<{ id: string }>("select id from public.library_categories where organization_id = $1 order by position limit 1", [org])).rows[0].id;
      await q("insert into public.library_items (organization_id, category_id, kind, title, url) values ($1, $2, 'link', 'קטלוג של א', 'https://a.example.com/catalog')", [
        org,
        ids.libraryCategoryA,
      ]);
      ids.libraryFileA = (await q<{ id: string }>("insert into public.library_items (organization_id, kind, title) values ($1, 'file', 'מצגת של א') returning id", [org])).rows[0].id;
      await q("insert into public.files (organization_id, library_item_id, name, mime_type, size_bytes) values ($1, $2, 'מצגת.pdf', 'application/pdf', 1000)", [
        org,
        ids.libraryFileA,
      ]);
      // SEG-03: a campaign cost of A
      await q("insert into public.campaign_costs (organization_id, campaign, month, amount_agorot) values ($1, 'קמפיין של א', '2026-10-01', 50000)", [org]);
      // BIZ-02: a's business card (its form is made by the card's trigger)
      await q("insert into public.business_cards (organization_id, user_id, job_title) values ($1, $2, 'יועץ')", [org, owner.id]);
      // BIZ-03: a QR code of A that opens A's form
      await q("insert into public.qr_codes (organization_id, name, target_kind, form_id) values ($1, 'שלט בחנות', 'form', $2)", [org, ids.formA]);
      // BIZ-03: a QR code of A that opens a link
      await q("insert into public.qr_codes (organization_id, name, target_kind, target_url) values ($1, 'ביקורות', 'url', 'https://a.example.com/')", [org]);
      // SPD-07: a site widget of A (its form is made by the widget's trigger)
      await q("insert into public.site_widgets (organization_id, name) values ($1, 'האתר של א')", [org]);
      // INT-02: a provider connection of A (no secret yet)
      ids.integrationA = (
        await q<{ id: string }>("insert into public.integrations (organization_id, provider, external_id, name) values ($1, 'meta_lead_ads', '7770' || $2, 'הדף של א') returning id", [org, tag])
      ).rows[0].id;
      // CAP-11: a mapped Meta form on A's page (the default row is made with the connection)
      await q("insert into public.meta_lead_forms (organization_id, integration_id, meta_form_id, name) values ($1, $2, '5550' || $3, 'טופס של א')", [org, ids.integrationA, tag]);
      ids.productA = (
        await q<{ id: string }>("insert into public.products (organization_id, name, sku, price_agorot) values ($1, 'מוצר של א', 'A-1', 10000) returning id", [org])
      ).rows[0].id;
      // PRD-06: the product's cost, in its own table
      await q("insert into public.product_costs (organization_id, product_id, cost_agorot) values ($1, $2, 6000)", [org, ids.productA]);
      // PRD-09: a bundle of A made of A's product
      ids.bundleA = (
        await q<{ id: string }>("insert into public.products (organization_id, name, kind, price_agorot) values ($1, 'חבילה של א', 'bundle', 15000) returning id", [org])
      ).rows[0].id;
      await q("insert into public.product_bundle_items (organization_id, bundle_id, component_id, quantity) values ($1, $2, $3, 2)", [org, ids.bundleA, ids.productA]);
      ids.priceListA = (
        await q<{ id: string }>("insert into public.price_lists (organization_id, name, valid_from) values ($1, 'מחירון של א', '2026-01-01') returning id", [org])
      ).rows[0].id;
      await q("insert into public.price_list_lines (organization_id, price_list_id, product_id, price_agorot) values ($1, $2, $3, 9000)", [
        org,
        ids.priceListA,
        ids.productA,
      ]);
      // DLI-01: a product line on the deal (PRD-06: it gets a copy of the product's cost, deal_line_costs)
      ids.dealLineA = (
        await q<{ id: string }>(
          "insert into public.deal_lines (organization_id, deal_id, product_id, description, quantity, unit_price_agorot, price_source) values ($1, $2, $3, 'מוצר של א', 2, 10000, 'product') returning id",
          [org, ids.dealA, ids.productA],
        )
      ).rows[0].id;
      // and a free line, which has no cost yet
      ids.freeLineA = (
        await q<{ id: string }>("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot) values ($1, $2, 'שורה חופשית של א', 500) returning id", [
          org,
          ids.dealA,
        ])
      ).rows[0].id;
      await q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה')", [org, ids.leadA]);
      // QUO-01: a draft quote on the deal, with a line
      ids.quoteA = (await q<{ id: string }>("insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה של א', $2) returning id", [org, ids.dealA])).rows[0].id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, unit_price_agorot) values ($1, $2, 'שורה של א', 1000)", [org, ids.quoteA]);
      // GAP-09
      await q("insert into public.quote_payment_steps (organization_id, quote_id, name, percent_bp, milestone) values ($1, $2, 'מקדמה', 3000, 'בחתימה')", [org, ids.quoteA]);
      // QUO-04: a template with a product line
      ids.templateA = (await q<{ id: string }>("insert into public.quote_templates (organization_id, name) values ($1, 'תבנית של א') returning id", [org])).rows[0].id;
      await q("insert into public.quote_template_lines (organization_id, template_id, product_id, name) values ($1, $2, $3, 'מוצר של א')", [org, ids.templateA, ids.productA]);
      await q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date + 40, current_date + 41)", [org, owner.id]);
      await q(`insert into public.card_layouts (organization_id, object_type, groups) values ($1, 'lead', '[{"title": "קשר", "columns": 2, "fields": ["phone", "email"]}]')`, [org]);
      // LEAD-05
      await q("insert into public.lead_score_rules (organization_id, field, op, points) values ($1, 'email', 'filled', 5)", [org]);
      // CAP-08: weights need no plan key, nor does a rule that is switched off
      await q("insert into public.lead_distribution_settings (organization_id, weights) values ($1, $2)", [org, JSON.stringify({ [owner.id]: 2 })]);
      await q(
        "insert into public.lead_routing_rules (organization_id, is_active, product_id, team_id) values ($1, false, $2, (select id from public.teams where organization_id = $1 limit 1))",
        [org, ids.productA],
      );
    });
    // PRM-01: a member of org A with an extra permission
    const helper = await createUser("alice-helper");
    await asAdmin(async (q) => {
      await q("insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'member')", [org, helper.id]);
    });
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{export}')", [org, helper.id]));
    // QUO-09: a customer's decision is written only by public.quote_public_decide (no client grant)
    await asAdmin((q) =>
      q("insert into public.quote_decisions (organization_id, quote_id, decision, content_sha256, ip) values ($1, $2, 'rejected', repeat('0', 64), '203.0.113.7')", [org, ids.quoteA]),
    );
    // QUO-10: the customer opened A's quote (written by the server only)
    await asAdmin((q) => q("insert into public.quote_views (organization_id, quote_id) values ($1, $2)", [org, ids.quoteA]));
    // PRK-02: a privacy request to A (written only by public.privacy_request_submit; no client insert grant)
    await asAdmin((q) =>
      q("insert into public.privacy_requests (organization_id, request_type, requester_name, contact_kind, contact_value, target_date) values ($1, 'access', 'פונה', 'email', 'p@example.com', current_date + 30)", [org]),
    );
    // MSG-03: a message sent to A's contact (written by the server only)
    await asAdmin((q) =>
      q("insert into public.messages (organization_id, contact_id, channel, direction, status) values ($1, $2, 'sms', 'outbound', 'sent')", [org, ids.contactA]),
    );
    // PKG-01, PKG-02: a punch card of A's contact and one entry used on it (written only by the punch_card_* functions
    // and the meetings trigger; no client write grant)
    await asAdmin(async (q) => {
      const product = (
        await q<{ id: string }>("insert into public.products (organization_id, name, kind, punch_entries) values ($1, 'כרטיסייה של א', 'punch_card', 10) returning id", [org])
      ).rows[0].id;
      ids.punchCardA = (
        await q<{ id: string }>(
          "insert into public.punch_cards (organization_id, contact_id, product_id, name, entries_total, status, activated_at) values ($1, $2, $3, 'כרטיסייה של א', 10, 'active', now()) returning id",
          [org, ids.contactA, product],
        )
      ).rows[0].id;
      await q("insert into public.punch_card_uses (organization_id, card_id, used_on) values ($1, $2, current_date)", [org, ids.punchCardA]);
    });
    // CNS-06: a blocklist entry of A (written only by consent_blocklist_add; no client write grant)
    await asAdmin((q) =>
      q("insert into public.consent_blocklist (organization_id, kind, channel, address_hash, reason) values ($1, 'phone', 'sms', repeat('a', 64), 'other')", [org]),
    );
    // ORD-01: a draft order on A's deal, with a line (both businesses have the plan's orders key)
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"orders\": true}' where organization_id = any($1::uuid[])", [[org]]),
    );
    await asUser(owner.id, async (q) => {
      ids.orderA = (await q<{ id: string }>("insert into public.orders (organization_id, deal_id, contact_id, notes) values ($1, $2, $3, 'הזמנה של א') returning id", [org, ids.dealA, ids.contactA])).rows[0].id;
      await q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot) values ($1, $2, 'שורה של א', 1000)", [org, ids.orderA]);
      // ORD-04
      await q("insert into public.order_payment_steps (organization_id, order_id, name, percent_bp, milestone) values ($1, $2, 'מקדמה', 3000, 'באישור')", [org, ids.orderA]);
      // DOC-01
      ids.documentA = (
        await q<{ id: string }>("insert into public.accounting_documents (organization_id, deal_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'A-1', 1000) returning id", [
          org,
          ids.dealA,
        ])
      ).rows[0].id;
      // DOC-02: a line, written with its document (same transaction)
      await q("insert into public.accounting_document_lines (organization_id, document_id, description, unit_price_agorot) values ($1, $2, 'שורה של א', 1000)", [org, ids.documentA]);
      // DOC-01 follow-up: the document's file (its one subject is the document)
      await q("insert into public.files (organization_id, accounting_document_id, name, mime_type, size_bytes) values ($1, $2, 'קבלה.pdf', 'application/pdf', 1000)", [
        org,
        ids.documentA,
      ]);
      // PAY-01
      ids.paymentA = (
        await q<{ id: string }>("insert into public.payments (organization_id, deal_id, amount_agorot, method, reference) values ($1, $2, 1000, 'cash', 'A-1') returning id", [
          org,
          ids.dealA,
        ])
      ).rows[0].id;
      // PAY-01 follow-up: the payment's file (its one subject is the payment)
      await q("insert into public.files (organization_id, payment_id, name, mime_type, size_bytes) values ($1, $2, 'אישור.pdf', 'application/pdf', 1000)", [org, ids.paymentA]);
      // PAY-02: a tax invoice on the same deal, and part of the payment allocated to it
      ids.invoiceA = (
        await q<{ id: string }>("insert into public.accounting_documents (organization_id, deal_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', 'A-INV', 1000) returning id", [
          org,
          ids.dealA,
        ])
      ).rows[0].id;
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 500)", [org, ids.paymentA, ids.invoiceA]);
      // PAY-08: part of the payment refunded
      await q("insert into public.payment_refunds (organization_id, payment_id, amount_agorot, method) values ($1, $2, 100, 'cash')", [org, ids.paymentA]);
      // GAP-12: a negative opening balance of A's contact, offset against a tax invoice of the contact
      ids.openingCreditA = (
        await q<{ id: string }>("select public.opening_balance_set($1, $2, null, -800, '2026-01-01') as id", [org, ids.contactA])
      ).rows[0].id;
      ids.contactInvoiceA = (
        await q<{ id: string }>("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'tax_invoice', 'A-INV-C', 1000) returning id", [
          org,
          ids.contactA,
        ])
      ).rows[0].id;
      await q("insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot) values ($1, $2, $3, 300)", [
        org,
        ids.openingCreditA,
        ids.contactInvoiceA,
      ]);
      // COL-05
      await q("insert into public.customer_holds (organization_id, contact_id, reason) values ($1, $2, 'חוב פתוח')", [org, ids.contactA]);
      // COL-03
      await q("insert into public.payment_promises (organization_id, document_id, promised_date, note) values ($1, $2, current_date + 5, 'יעביר בשבוע הבא')", [org, ids.invoiceA]);
      // COL-03 (1) ג: a promise on the whole company, covering its open documents (the server writes the covered set)
      await q("insert into public.payment_promises (organization_id, company_id, promised_date) values ($1, $2, current_date + 9)", [org, ids.companyA]);
    });
    // PAY-03: the server's row of A's payment on A's company (kept by triggers; no client grant)
    await asAdmin((q) =>
      q(
        "insert into public.payment_credit_companies (organization_id, payment_id, company_id, credit_agorot) values ($1, $2, $3, 500) on conflict (organization_id, payment_id, company_id) do nothing",
        [org, ids.paymentA, ids.companyA],
      ),
    );
    await asAdmin((q) =>
      q(
        "insert into public.customer_credit_totals (organization_id, company_id, credit_agorot) values ($1, $2, 500) on conflict (organization_id, company_id) do nothing",
        [org, ids.companyA],
      ),
    );
    // BAL-02: the server's debt rows of A's invoice and A's company total (kept by triggers; no client grant)
    await asAdmin((q) =>
      q(
        "insert into public.debt_document_customers (organization_id, document_id, company_id, balance_agorot) values ($1, $2, $3, 500) on conflict (organization_id, document_id, company_id) do nothing",
        [org, ids.contactInvoiceA, ids.companyA],
      ),
    );
    await asAdmin((q) =>
      q(
        "insert into public.customer_debt_totals (organization_id, company_id, open_agorot) values ($1, $2, 500) on conflict (organization_id, company_id) do nothing",
        [org, ids.companyA],
      ),
    );
    // ORD-05: a customer's answer on an order is written only by public.order_public_decide (no client grant)
    await asAdmin((q) =>
      q("insert into public.order_decisions (organization_id, order_id, decision, content_sha256, ip) values ($1, $2, 'rejected', repeat('0', 64), '203.0.113.7')", [org, ids.orderA]),
    );
    await asService((q) =>
      q("select public.intake_submit($1, 'form', $2)", [ids.formTokenA, JSON.stringify({ full_name: "פונה מהאתר", phone: "050-7654321" })]),
    );
    await asAdmin((q) => q("select app.process_outbox(5000)"));
  return ids;
}

/** A storage object for every file row, and a logo, so the cleanup queue can be checked against real paths. */
export async function storageFor(owner: { id: string }, org: string): Promise<string> {
  const logo = `${org}/${randomUUID()}`;
  await asAdmin(async (q) => {
    await q("insert into storage.objects (bucket_id, name) select 'record-files', f.storage_path from public.files f where f.organization_id = $1", [org]);
    await q("insert into storage.objects (bucket_id, name) values ('org-logos', $1)", [logo]);
  });
  await asUser(owner.id, (q) => q("update public.organizations set logo_path = $2 where id = $1", [org, logo]));
  return logo;
}

export const orphanPaths = (org: string) =>
  asAdmin(async (q) =>
    (await q<{ p: string }>("select storage_path as p from app.orphan_files where storage_path like $1 order by 1", [`${org}/%`])).rows.map((r) => r.p),
  );

export const exists = (sql: string, params: unknown[]) => asAdmin(async (q) => ((await q(sql, params)).rowCount ?? 0) > 0);

/** A quote PDF the server keeps (the quote sent, the file confirmed): it goes only through files_keep_attached's erasure path. */
export async function keptQuotePdf(org: string): Promise<void> {
  await asAdmin(async (q) => {
    const quote = (await q<{ id: string }>("select id from public.quotes where organization_id = $1 order by id limit 1", [org])).rows[0].id;
    await q("insert into public.quote_payment_steps (organization_id, quote_id, name, percent_bp, milestone) values ($1, $2, 'יתרה', 7000, 'בסיום')", [org, quote]);
    await q("update public.quotes set status = 'sent', sent_at = now() where id = $1", [quote]);
  });
  await asAdmin(async (q) => {
    const quote = (await q<{ id: string }>("select id from public.quotes where organization_id = $1 order by id limit 1", [org])).rows[0].id;
    await q(
      "insert into public.files (organization_id, quote_id, name, mime_type, size_bytes, sha256) values ($1, $2, 'הצעה.pdf', 'application/pdf', 1000, repeat('d', 64))",
      [org, quote],
    );
    await q("update public.files set unconfirmed_since = null where organization_id = $1 and quote_id is not null", [org]);
  });
}

/** Per-person rows outside any business (signatures, backup codes, sessions) for the given users. */
export async function personExtras(users: string[]): Promise<void> {
  await asAdmin(async (q) => {
    for (const u of users) {
      await q(
        `insert into app.agreement_signatures (user_id, version, documents, content_hash, full_name, method)
         values ($1, '2026-10-07', '[{"slug":"terms","title":"t","text":"x"}]', repeat('b', 64), 'שם', 'typed')`,
        [u],
      );
      await q("insert into app.mfa_recovery_codes (user_id, code_hash) values ($1, repeat('c', 64))", [u]);
      await q("insert into auth.sessions (user_id, aal) values ($1, 'aal1')", [u]);
    }
  });
}

/** A verified second factor; last in a fixture, because it takes an aal1 session's role away. */
export async function verifiedFactors(users: string[]): Promise<void> {
  await asAdmin(async (q) => {
    for (const u of users) await q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [u]);
  });
}

export const filePaths = (org: string, where: string) =>
  asAdmin(async (q) =>
    (await q<{ p: string }>(`select storage_path as p from public.files where organization_id = $1 and ${where} order by 1`, [org])).rows.map((r) => r.p),
  );

export async function cleanupPrefixes(prefixes: string[]): Promise<void> {
  await asAdmin(async (q) => {
    await q("delete from app.orphan_files where storage_path like any($1)", [prefixes]);
    await q("delete from storage.objects where name like any($1)", [prefixes]);
  });
}

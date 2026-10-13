import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAdmin,
  asService,
  asUser,
  closePool,
  count,
  createOrg,
  createUser,
  defaultLeadStatus,
  defaultPipeline,
  insertLead,
  pgError,
} from "./helpers";

afterAll(closePool);

/**
 * The most important test file in the project: organization B must never
 * see, change or attach to anything that belongs to organization A.
 */
describe("tenant isolation", () => {
  let a: { id: string; email: string };
  let b: { id: string; email: string };
  let orgA: string;
  let orgB: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    a = await createUser("alice");
    b = await createUser("bob");
    orgA = await createOrg(a.id, "ארגון א");
    orgB = await createOrg(b.id, "ארגון ב");

    const pipe = await defaultPipeline(orgA);
    ids.pipelineA = pipe.pipelineId;
    ids.stageA = pipe.stages[0].id;
    ids.statusA = await defaultLeadStatus(orgA);
    ids.leadA = await insertLead(a.id, orgA, { phone: "050-1234567", company_name: "חברה א" });

    await asUser(a.id, async (q) => {
      ids.companyA = (
        await q<{ id: string }>("insert into public.companies (organization_id, name) values ($1, 'חברת סוד') returning id", [orgA])
      ).rows[0].id;
      ids.contactA = (
        await q<{ id: string }>(
          "insert into public.contacts (organization_id, first_name, company_id) values ($1, 'דנה', $2) returning id",
          [orgA, ids.companyA],
        )
      ).rows[0].id;
      ids.dealA = (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, amount_agorot) values ($1, 'עסקה סודית', $2, $3, 500000) returning id",
          [orgA, ids.pipelineA, ids.stageA],
        )
      ).rows[0].id;
      ids.taskA = (
        await q<{ id: string }>(
          "insert into public.tasks (organization_id, title, lead_id) values ($1, 'לחזור ללקוח', $2) returning id",
          [orgA, ids.leadA],
        )
      ).rows[0].id;
      ids.activityA = (
        await q<{ id: string }>(
          "insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'הערה פנימית', $2) returning id",
          [orgA, ids.leadA],
        )
      ).rows[0].id;
      await q(
        "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'הצעה.pdf', 'application/pdf', 1000)",
        [orgA, ids.leadA],
      );
      ids.tagA = (
        await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'VIP') returning id", [orgA])
      ).rows[0].id;
      ids.leadFieldA = (
        await q<{ id: string }>(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'budget_range', 'טווח תקציב', 'text') returning id",
          [orgA],
        )
      ).rows[0].id;
      ids.contactFieldA = (
        await q<{ id: string }>(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'contact', 'budget_note', 'הערת תקציב', 'text') returning id",
          [orgA],
        )
      ).rows[0].id;
      // LEAD-06
      await q(
        "insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, target_field_id) values ($1, $2, 'contact', $3)",
        [orgA, ids.leadFieldA, ids.contactFieldA],
      );
      await q("insert into public.teams (organization_id, name) values ($1, 'מכירות')", [orgA]);
      await q("select public.create_invitation($1, 'someone@example.test')", [orgA]);
      const form = (
        await q<{ id: string; token: string }>("insert into public.forms (organization_id, name) values ($1, 'טופס אתר') returning id, token", [orgA])
      ).rows[0];
      ids.formA = form.id;
      ids.formTokenA = form.token;
      ids.automationA = (
        await q<{ id: string }>(
          "insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'כלל', 'lead', 'created', '[{\"type\":\"notify\"}]') returning id",
          [orgA],
        )
      ).rows[0].id;
      await q("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'leads.csv', 'skip')", [orgA]);
      await q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [orgA]);
      await q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'lead', '[{\"key\": \"phone\"}]')", [orgA]);
      await q("insert into public.record_followers (organization_id, lead_id) values ($1, $2)", [orgA, ids.leadA]);
      await q("insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{6}')", [orgA]);
      await q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [orgA]);
      await q("insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account) values ($1, 'בנק', '800', '1234567')", [orgA]);
      ids.meetingA = (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'פגישת היכרות', now() + interval '1 day', now() + interval '1 day 1 hour', $2) returning id",
          [orgA, ids.leadA],
        )
      ).rows[0].id;
      await q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [orgA, ids.meetingA, a.id]);
      // a second meeting with nobody on it yet: the target of the forged participant insert below
      ids.meetingA2 = (
        await q<{ id: string }>(
          "insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'ישיבת צוות', now() + interval '2 days', now() + interval '2 days 1 hour') returning id",
          [orgA],
        )
      ).rows[0].id;
      await q("insert into public.disqualify_reasons (organization_id, name) values ($1, 'סיבה של א')", [orgA]);
      await q("insert into public.deal_loss_reasons (organization_id, name) values ($1, 'סיבת הפסד של א')", [orgA]);
      await q("insert into public.goals (organization_id, scope, period, period_start, metric, target) values ($1, 'org', 'month', '2026-10-01', 'won_amount', 100000)", [orgA]);
      await q("insert into public.record_type_options (organization_id, object_type, name) values ($1, 'contact', 'סוג של א')", [orgA]);
      await q("insert into public.contact_channels (organization_id, contact_id, kind, label, value) values ($1, $2, 'phone', 'other', '052-7000001')", [orgA, ids.contactA]);
      await q("insert into public.plan_waitlist (organization_id, plan_key) values ($1, 'business')", [orgA]);
      ids.productA = (
        await q<{ id: string }>("insert into public.products (organization_id, name, sku, price_agorot) values ($1, 'מוצר של א', 'A-1', 10000) returning id", [orgA])
      ).rows[0].id;
      ids.priceListA = (
        await q<{ id: string }>("insert into public.price_lists (organization_id, name, valid_from) values ($1, 'מחירון של א', '2026-01-01') returning id", [orgA])
      ).rows[0].id;
      await q("insert into public.price_list_lines (organization_id, price_list_id, product_id, price_agorot) values ($1, $2, $3, 9000)", [
        orgA,
        ids.priceListA,
        ids.productA,
      ]);
      await q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה')", [orgA, ids.leadA]);
      await q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-12-01', '2026-12-02')", [orgA, a.id]);
    });
    await asService((q) =>
      q("select public.intake_submit($1, 'form', $2)", [ids.formTokenA, JSON.stringify({ full_name: "פונה מהאתר", phone: "050-7654321" })]),
    );
    await asAdmin((q) => q("select app.process_outbox(5000)"));
  });

  const tenantTables = [
    "memberships",
    "teams",
    "invitations",
    "subscriptions",
    "org_usage",
    "pipelines",
    "stages",
    "lead_statuses",
    "lead_sources",
    "tags",
    "companies",
    "contacts",
    "leads",
    "deals",
    "activities",
    "tasks",
    "field_definitions",
    "audit_log",
    "forms",
    "form_submissions",
    "automations",
    "automation_runs",
    "import_jobs",
    "support_access_grants",
    "files",
    "list_preferences",
    "record_followers",
    "meetings",
    "meeting_participants",
    "disqualify_reasons",
    "org_calendar_settings",
    "org_document_settings",
    "org_bank_details",
    "record_type_options",
    "contact_channels",
    "plan_waitlist",
    "consents",
    // seeded for every new organization (WA-01)
    "whatsapp_templates",
    // DEAL-03, also seeded
    "deal_loss_reasons",
    // GOL-01
    "goals",
    // PRD-04, seeded for every new organization
    "product_categories",
    "product_units",
    // PRD-01
    "products",
    // PL-01
    "price_lists",
    // PL-02
    "price_list_lines",
    // DQL-01, seeded for every new organization
    "completeness_settings",
    // CAP-09
    "member_leaves",
    // LEAD-06
    "conversion_field_maps",
  ];
  // filled in by the "every table, every verb" test and re-checked for reads there
  const lateTables = ["team_members", "deal_contacts", "saved_views"];

  it("the owner sees their own rows (so a zero below means isolation, not a broken query)", async () => {
    await asUser(a.id, async (q) => {
      for (const table of tenantTables) {
        const n = await count(q, `select 1 from public.${table} where organization_id = $1`, [orgA]);
        expect(n, `alice should see rows in ${table}`).toBeGreaterThan(0);
      }
      expect(await count(q, "select 1 from public.organizations where id = $1", [orgA])).toBe(1);
    });
  });

  it("another organization sees none of them", async () => {
    await asUser(b.id, async (q) => {
      for (const table of tenantTables) {
        const n = await count(q, `select 1 from public.${table} where organization_id = $1`, [orgA]);
        expect(n, `bob must not see ${table} of org A`).toBe(0);
      }
      expect(await count(q, "select 1 from public.organizations where id = $1", [orgA])).toBe(0);
      expect(await count(q, "select 1 from public.profiles where id = $1", [a.id])).toBe(0);
      expect(await count(q, "select 1 from public.notifications")).toBe(0);
      // unfiltered: bob's whole view of the business tables is his own (empty) org
      for (const table of ["leads", "contacts", "companies", "deals", "tasks", "activities", "meetings", "meeting_participants"]) {
        expect(await count(q, `select 1 from public.${table}`), table).toBe(0);
      }
      expect(await count(q, "select 1 from public.organizations")).toBe(1);
    });
  });

  it("cannot insert rows into another organization", async () => {
    const lead = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.leads (organization_id, status_id, full_name) values ($1, $2, 'פולש')", [orgA, ids.statusA]),
      ),
    );
    expect(lead.code).toBe("42501");

    const contact = await pgError(
      asUser(b.id, (q) => q("insert into public.contacts (organization_id, first_name) values ($1, 'פולש')", [orgA])),
    );
    expect(contact.code).toBe("42501");

    const note = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)", [orgA, ids.leadA]),
      ),
    );
    expect(note.code).toBe("42501");

    const pipeline = await pgError(
      asUser(b.id, (q) => q("insert into public.pipelines (organization_id, name) values ($1, 'x')", [orgA])),
    );
    expect(pipeline.code).toBe("42501");
  });

  it("cannot update or delete another organization's rows", async () => {
    await asUser(b.id, async (q) => {
      expect((await q("update public.leads set full_name = 'נפרץ' where id = $1", [ids.leadA])).rowCount).toBe(0);
      expect((await q("update public.deals set amount_agorot = 1 where id = $1", [ids.dealA])).rowCount).toBe(0);
      expect((await q("update public.organizations set name = 'נפרץ' where id = $1", [orgA])).rowCount).toBe(0);
      expect((await q("update public.memberships set role = 'admin' where organization_id = $1", [orgA])).rowCount).toBe(0);
      expect((await q("update public.leads set deleted_at = now() where id = $1", [ids.leadA])).rowCount).toBe(0);
      expect((await q("delete from public.leads where id = $1", [ids.leadA])).rowCount).toBe(0);
      expect((await q("delete from public.tags where id = $1", [ids.tagA])).rowCount).toBe(0);
      expect((await q("delete from public.memberships where organization_id = $1", [orgA])).rowCount).toBe(0);
    });
    const name = await asAdmin(async (q) =>
      (await q<{ full_name: string }>("select full_name from public.leads where id = $1", [ids.leadA])).rows[0].full_name,
    );
    expect(name).toBe("ישראל ישראלי");
  });

  it("cannot write to ANY table of another organization (every table, every verb)", async () => {
    // A no-op UPDATE and a DELETE aimed at org A's rows, per table. Zero rows
    // affected (or a permission error) is the only acceptable outcome.
    const noop: Record<string, string> = {
      organizations: "name = name",
      memberships: "is_available = is_available",
      teams: "name = name",
      team_members: "is_manager = is_manager",
      invitations: "revoked_at = revoked_at",
      pipelines: "name = name",
      stages: "name = name",
      lead_statuses: "name = name",
      lead_sources: "name = name",
      tags: "name = name",
      companies: "name = name",
      contacts: "first_name = first_name",
      leads: "full_name = full_name",
      deals: "name = name",
      deal_contacts: "role = role",
      activities: "body = body",
      tasks: "title = title",
      field_definitions: "label = label",
      saved_views: "name = name",
      forms: "name = name",
      form_submissions: "status = status",
      automations: "name = name",
      automation_runs: "status = status",
      import_jobs: "status = status",
      support_access_grants: "revoked_at = revoked_at",
      files: "name = name",
      list_preferences: "columns = columns",
      // no update grant at all: a permission error is the expected outcome
      record_followers: "user_id = user_id",
      meetings: "title = title",
      // no update grant at all: a permission error is the expected outcome
      meeting_participants: "user_id = user_id",
      disqualify_reasons: "name = name",
      org_calendar_settings: "holidays_rest = holidays_rest",
      org_document_settings: "vat_status = vat_status",
      org_bank_details: "bank_name = bank_name",
      record_type_options: "name = name",
      contact_channels: "label = label",
      // no update or delete grant at all: a permission error is the expected outcome
      plan_waitlist: "plan_key = plan_key",
      // append-only (CNS-02): no update or delete grant, a permission error is the expected outcome
      consents: "state = state",
      whatsapp_templates: "name = name",
      deal_loss_reasons: "name = name",
      goals: "target = target",
      product_categories: "name = name",
      product_units: "name = name",
      products: "name = name",
      price_lists: "name = name",
      price_list_lines: "min_quantity = min_quantity",
      completeness_settings: "fields = fields",
      member_leaves: "ends_on = ends_on",
      conversion_field_maps: "target_field_id = target_field_id",
    };
    await asUser(a.id, async (q) => {
      const team = (await q<{ id: string }>("select id from public.teams where organization_id = $1 limit 1", [orgA])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [orgA, team, a.id]);
      await q("insert into public.deal_contacts (organization_id, deal_id, contact_id) values ($1, $2, $3)", [orgA, ids.dealA, ids.contactA]);
      await q(
        "insert into public.saved_views (organization_id, object_type, name, scope, owner_id) values ($1, 'lead', 'תצוגה', 'org', $2)",
        [orgA, a.id],
      );
    });

    for (const [table, assignment] of Object.entries(noop)) {
      const key = table === "organizations" ? "id" : "organization_id";
      for (const sql of [
        `update public.${table} set ${assignment} where ${key} = $1`,
        `delete from public.${table} where ${key} = $1`,
      ]) {
        const outcome = await asUser(b.id, (q) => q(sql, [orgA])).then(
          (res) => ({ rows: res.rowCount ?? 0, code: undefined as string | undefined }),
          (err: { code?: string }) => ({ rows: 0, code: err.code }),
        );
        expect(outcome.rows, sql).toBe(0);
        if (outcome.code) expect(outcome.code, sql).toBe("42501");
      }
      // and the rows are still there
      const left = await asAdmin((q) => count(q, `select 1 from public.${table} where ${key} = $1`, [orgA]));
      expect(left, `${table} rows of org A survived`).toBeGreaterThan(0);
    }

    await asUser(b.id, async (q) => {
      for (const table of lateTables) {
        expect(await count(q, `select 1 from public.${table} where organization_id = $1`, [orgA]), table).toBe(0);
      }
    });

    // INSERT into org A, per table, with ids that are valid inside org A
    const team = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.teams where organization_id = $1 limit 1", [orgA])).rows[0].id,
    );
    const inserts: [string, unknown[]][] = [
      ["insert into public.companies (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'x', $2, $3)", [orgA, ids.pipelineA, ids.stageA]],
      ["insert into public.tasks (organization_id, title) values ($1, 'x')", [orgA]],
      ["insert into public.tags (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.teams (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [orgA, team, a.id]],
      ["insert into public.stages (organization_id, pipeline_id, name) values ($1, $2, 'x')", [orgA, ids.pipelineA]],
      ["insert into public.lead_statuses (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.lead_sources (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'deal', 'x', 'x', 'text')", [orgA]],
      ["insert into public.saved_views (organization_id, object_type, name, owner_id) values ($1, 'lead', 'x', $2)", [orgA, a.id]],
      ["insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, 'finance')", [orgA, ids.dealA, ids.contactA]],
      ["insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'admin')", [orgA, b.id]],
      ["insert into public.organizations (name, slug) values ('x', 'forged-org')", []],
      ["insert into public.subscriptions (organization_id, plan_key) values ($1, 'business')", [orgA]],
      ["insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'x', 'x')", [orgA, a.id]],
      ["insert into public.audit_log (organization_id, action, entity_type) values ($1, 'x', 'x')", [orgA]],
      ["insert into public.forms (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.form_submissions (organization_id, form_id, status) values ($1, $2, 'accepted')", [orgA, ids.formA]],
      ["insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'x', 'lead', 'created', '[{\"type\":\"notify\"}]')", [orgA]],
      ["insert into public.automation_runs (organization_id, automation_id, entity_type, entity_id, run_key, status) values ($1, $2, 'lead', $3, 'x', 'success')", [orgA, ids.automationA, ids.leadA]],
      ["insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'x.csv', 'skip')", [orgA]],
      ["insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [orgA]],
      ["insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'x', 'text/plain', 1)", [orgA, ids.leadA]],
      ["insert into public.list_preferences (organization_id, object_type) values ($1, 'contact')", [orgA]],
      ["insert into public.record_followers (organization_id, deal_id) values ($1, $2)", [orgA, ids.dealA]],
      // no organizer: the policy, not the organizer trigger, has to refuse it
      ["insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'x', now(), now() + interval '1 hour')", [orgA]],
      ["insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [orgA, ids.meetingA2, a.id]],
      ["insert into public.disqualify_reasons (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{0}')", [orgA]],
      ["insert into public.org_document_settings (organization_id, vat_status) values ($1, 'exempt')", [orgA]],
      ["insert into public.org_bank_details (organization_id, bank_name) values ($1, 'x')", [orgA]],
      ["insert into public.record_type_options (organization_id, object_type, name) values ($1, 'company', 'x')", [orgA]],
      ["insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'email', 'x@example.test')", [orgA, ids.contactA]],
      ["insert into public.plan_waitlist (organization_id, plan_key) values ($1, 'business')", [orgA]],
      ["insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'denied', 'manual', 'x')", [orgA, ids.leadA]],
      ["insert into public.whatsapp_templates (organization_id, name, body) values ($1, 'x', 'x')", [orgA]],
      ["insert into public.deal_loss_reasons (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.goals (organization_id, scope, period, period_start, metric, target) values ($1, 'org', 'month', '2026-11-01', 'won_deals', 1)", [orgA]],
      ["insert into public.product_categories (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.product_units (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.products (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.price_lists (organization_id, name) values ($1, 'x')", [orgA]],
      ["insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, discount_bp) values ($1, $2, $3, 5, 100)", [orgA, ids.priceListA, ids.productA]],
      ["insert into public.completeness_settings (organization_id, object_type, fields) values ($1, 'lead', '{phone}')", [orgA]],
      ["insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-12-05', '2026-12-06')", [orgA, a.id]],
      ["insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, mode) values ($1, $2, 'deal', 'none')", [orgA, ids.leadFieldA]],
    ];
    for (const [sql, params] of inserts) {
      const err = await pgError(asUser(b.id, (q) => q(sql, params)));
      expect(["42501", "23505"], sql).toContain(err.code);
    }
  });

  it("an UPDATE or DELETE with no WHERE clause never reaches another organization", async () => {
    // Postgres applies SELECT policies to UPDATE/DELETE only when the statement
    // reads the existing row (WHERE / RETURNING). A bare "delete from t" is
    // filtered by the DELETE policy alone -- so each write policy has to carry
    // the tenant check itself. This test is what proves that.
    const mallory = await createUser("mallory");
    await createOrg(mallory.id, "ארגון זדוני");

    await asAdmin((q) =>
      q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'system', 'הודעה')", [orgA, a.id]),
    );

    // [table, SET clause that leaves a visible mark, SQL condition that detects the mark]
    const marks: [string, string, string][] = [
      ["organizations", "name = 'HACKED'", "name = 'HACKED'"],
      ["profiles", "full_name = 'HACKED'", "full_name = 'HACKED'"],
      ["memberships", "is_available = false", "not is_available"],
      ["teams", "name = 'HACKED'", "name = 'HACKED'"],
      ["team_members", "is_manager = true", "is_manager"],
      ["invitations", "revoked_at = '2001-01-01'", "revoked_at = '2001-01-01'"],
      ["pipelines", "name = 'HACKED'", "name = 'HACKED'"],
      ["stages", "name = 'HACKED'", "name = 'HACKED'"],
      ["lead_statuses", "name = 'HACKED'", "name = 'HACKED'"],
      ["lead_sources", "name = 'HACKED'", "name = 'HACKED'"],
      ["tags", "color = 'HACKED'", "color = 'HACKED'"],
      ["companies", "industry = 'HACKED'", "industry = 'HACKED'"],
      ["contacts", "job_title = 'HACKED'", "job_title = 'HACKED'"],
      ["leads", "campaign = 'HACKED'", "campaign = 'HACKED'"],
      ["deals", "lost_reason = 'HACKED'", "lost_reason = 'HACKED'"],
      ["deal_contacts", "role = 'finance'", "role = 'finance'"],
      ["activities", "body = 'HACKED'", "body = 'HACKED'"],
      ["tasks", "outcome = 'HACKED'", "outcome = 'HACKED'"],
      ["field_definitions", "help_text = 'HACKED'", "help_text = 'HACKED'"],
      ["saved_views", "name = 'HACKED'", "name = 'HACKED'"],
      ["forms", "title = 'HACKED'", "title = 'HACKED'"],
      ["form_submissions", "user_agent = 'HACKED'", "user_agent = 'HACKED'"],
      ["automations", "name = 'HACKED'", "name = 'HACKED'"],
      ["automation_runs", "status = 'skipped'", "status = 'skipped'"],
      ["import_jobs", "status = 'failed'", "status = 'failed'"],
      ["support_access_grants", "revoked_at = '2001-01-01'", "revoked_at = '2001-01-01'"],
      ["notifications", "read_at = '2001-01-01'", "read_at = '2001-01-01'"],
      ["files", "name = 'HACKED'", "name = 'HACKED'"],
      ["list_preferences", "columns = '[{\"key\": \"HACKED\"}]'", "columns::text like '%HACKED%'"],
      ["record_followers", "created_at = '2001-01-01'", "created_at = '2001-01-01'"],
      ["meetings", "outcome = 'HACKED'", "outcome = 'HACKED'"],
      ["meeting_participants", "created_at = '2001-01-01'", "created_at = '2001-01-01'"],
      ["disqualify_reasons", "is_active = false", "not is_active"],
      ["org_calendar_settings", "holiday_eves_rest = true", "holiday_eves_rest"],
      ["org_document_settings", "vat_status = 'exempt'", "vat_status = 'exempt'"],
      ["org_bank_details", "bank_name = 'HACKED'", "bank_name = 'HACKED'"],
      ["record_type_options", "is_active = false", "not is_active"],
      ["contact_channels", "label = 'work'", "label = 'work'"],
      ["plan_waitlist", "created_at = '2001-01-01'", "created_at = '2001-01-01'"],
      ["consents", "state = 'denied'", "state = 'denied'"],
      ["whatsapp_templates", "body = 'HACKED'", "body = 'HACKED'"],
      ["deal_loss_reasons", "is_active = false", "not is_active"],
      ["goals", "target = 777", "target = 777"],
      ["product_categories", "position = 777", "position = 777"],
      ["product_units", "position = 777", "position = 777"],
      ["products", "description = 'HACKED'", "description = 'HACKED'"],
      ["price_lists", "is_active = false", "not is_active"],
      ["price_list_lines", "min_quantity = 777", "min_quantity = 777"],
      ["completeness_settings", "fields = '{city}'", "fields = '{city}'"],
      ["member_leaves", "ends_on = '2027-01-01'", "ends_on = '2027-01-01'"],
      ["conversion_field_maps", "target_field_id = null", "target_field_id is null"],
    ];
    // which rows of each table belong to alice's organization
    const scope = (table: string): [string, unknown[]] =>
      table === "organizations" ? ["id = $1", [orgA]] : table === "profiles" ? ["id = $1", [a.id]] : ["organization_id = $1", [orgA]];

    const before: Record<string, number> = {};
    await asAdmin(async (q) => {
      for (const [table] of marks) {
        const [where, params] = scope(table);
        before[table] = await count(q, `select 1 from public.${table} where ${where}`, params);
        expect(before[table], `${table} has rows to protect`).toBeGreaterThan(0);
      }
    });

    for (const [table, set] of marks) {
      await asUser(mallory.id, (q) => q(`update public.${table} set ${set}`)).catch((err: { code?: string }) => {
        expect(["42501", "23503", "23505", "23514", "P0001"], `${table}: ${String(err)}`).toContain(err.code);
      });
    }
    await asAdmin(async (q) => {
      for (const [table, , detect] of marks) {
        const [where, params] = scope(table);
        const touched = await count(q, `select 1 from public.${table} where ${where} and (${detect})`, params);
        expect(touched, `${table} was modified`).toBe(0);
      }
    });

    for (const [table] of [...marks].reverse()) {
      await asUser(mallory.id, (q) => q(`delete from public.${table}`)).catch((err: { code?: string }) => {
        expect(["42501", "23503"], `${table}: ${String(err)}`).toContain(err.code);
      });
    }
    await asAdmin(async (q) => {
      for (const [table] of marks) {
        const [where, params] = scope(table);
        const after = await count(q, `select 1 from public.${table} where ${where}`, params);
        expect(after, `${table} lost rows`).toBe(before[table]);
      }
    });
  });

  it("cannot point a row of its own at another organization's rows", async () => {
    const statusB = await defaultLeadStatus(orgB);
    const pipeB = await defaultPipeline(orgB);

    // a lead in org B using org A's status
    const viaStatus = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.leads (organization_id, status_id, full_name) values ($1, $2, 'x')", [orgB, ids.statusA]),
      ),
    );
    expect(viaStatus.code).toBe("23503");

    // a contact in org B attached to org A's company
    const viaCompany = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.contacts (organization_id, first_name, company_id) values ($1, 'x', $2)", [orgB, ids.companyA]),
      ),
    );
    expect(viaCompany.code).toBe("23503");

    // a deal in org B inside org A's pipeline
    const viaPipeline = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'x', $2, $3)", [
          orgB,
          ids.pipelineA,
          ids.stageA,
        ]),
      ),
    );
    expect(viaPipeline.code).toBe("23503");

    // a deal in org B, org B's pipeline, attached to org A's contact
    const viaContact = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'x', $2, $3, $4)", [
          orgB,
          pipeB.pipelineId,
          pipeB.stages[0].id,
          ids.contactA,
        ]),
      ),
    );
    expect(viaContact.code).toBe("23503");

    // a task in org B assigned to a user who is not a member of org B
    const viaOwner = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.tasks (organization_id, title, owner_id) values ($1, 'x', $2)", [orgB, a.id]),
      ),
    );
    expect(viaOwner.code).toBe("23503");

    // a note in org B hung on org A's lead
    const viaActivity = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'x', $2)", [orgB, ids.leadA]),
      ),
    );
    expect(["42501", "23503"]).toContain(viaActivity.code);

    // a file in org B hung on org A's lead
    const viaFile = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'x', 'text/plain', 1)", [orgB, ids.leadA]),
      ),
    );
    expect(["42501", "23503"]).toContain(viaFile.code);

    // a consent in org B recorded on org A's lead (CNS-01)
    const viaConsent = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'x')", [orgB, ids.leadA]),
      ),
    );
    expect(["42501", "23503"]).toContain(viaConsent.code);

    // a meeting in org B about org A's lead, and org A's colleague added to org B's meeting
    const viaMeeting = await pgError(
      asUser(b.id, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'x', now(), now() + interval '1 hour', $2)", [orgB, ids.leadA]),
      ),
    );
    expect(["42501", "23503"]).toContain(viaMeeting.code);
    const meetingB = await asUser(b.id, async (q) =>
      (await q<{ id: string }>("insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'x', now(), now() + interval '1 hour') returning id", [orgB])).rows[0].id,
    );
    const viaParticipant = await pgError(
      asUser(b.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [orgB, meetingB, a.id])),
    );
    expect(viaParticipant.code).toBe("23503");
    const viaForeignMeeting = await pgError(
      asUser(b.id, (q) => q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [orgB, ids.meetingA, b.id])),
    );
    expect(["42501", "23503"]).toContain(viaForeignMeeting.code);

    // a conversion mapping in org B from and to org A's custom fields (LEAD-06)
    const leadFieldB = await asUser(b.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.field_definitions (organization_id, object_type, key, label, field_type) values ($1, 'lead', 'b_note', 'הערה', 'text') returning id",
          [orgB],
        )
      ).rows[0].id,
    );
    for (const [lead, target] of [
      [ids.leadFieldA, null],
      [leadFieldB, ids.contactFieldA],
    ]) {
      const viaFieldMap = await pgError(
        asUser(b.id, (q) =>
          q("insert into public.conversion_field_maps (organization_id, lead_field_id, target_type, mode, target_field_id) values ($1, $2, 'contact', $3, $4)", [
            orgB,
            lead,
            target ? "field" : "none",
            target,
          ]),
        ),
      );
      expect(["23514", "23503"]).toContain(viaFieldMap.code);
    }

    // sanity: the same inserts work with org B's own ids
    await asUser(b.id, (q) =>
      q("insert into public.leads (organization_id, status_id, full_name) values ($1, $2, 'ליד של בוב')", [orgB, statusB]),
    );
  });

  it("cannot move a row to another organization", async () => {
    const leadB = await insertLead(b.id, orgB);
    const err = await pgError(
      asUser(b.id, (q) =>
        q("update public.leads set organization_id = $1, status_id = $2 where id = $3", [orgA, ids.statusA, leadB]),
      ),
    );
    expect(err.code).toBe("42501");
  });

  it("cannot reach another organization through the RPC functions", async () => {
    const convert = await pgError(asUser(b.id, (q) => q("select public.convert_lead($1)", [ids.leadA])));
    expect(convert.code).toBe("P0002");

    const invite = await pgError(
      asUser(b.id, (q) => q("select public.create_invitation($1, 'bob2@example.test')", [orgA])),
    );
    expect(invite.code).toBe("42501");

    const transfer = await pgError(asUser(b.id, (q) => q("select public.transfer_ownership($1, $2)", [orgA, b.id])));
    expect(transfer.code).toBe("42501");
  });

  it("a user who belongs to two organizations keeps them apart", async () => {
    // bob is invited into org A as a member, and still owns org B
    const token = await asUser(a.id, async (q) =>
      (await q<{ t: string }>("select public.create_invitation($1, $2) as t", [orgA, b.email])).rows[0].t,
    );
    await asUser(b.id, (q) => q("select public.accept_invitation($1)", [token]));

    await asUser(b.id, async (q) => {
      expect(await count(q, "select 1 from public.organizations")).toBe(2);
      // org A's default visibility is 'org', so bob now sees alice's lead...
      expect(await count(q, "select 1 from public.leads where id = $1", [ids.leadA])).toBe(1);
      // ...but as a plain member he cannot edit it or read the audit log
      expect((await q("update public.leads set full_name = 'x' where id = $1", [ids.leadA])).rowCount).toBe(0);
      expect(await count(q, "select 1 from public.audit_log where organization_id = $1", [orgA])).toBe(0);
    });

    // and alice still sees nothing of org B
    await asUser(a.id, async (q) => {
      expect(await count(q, "select 1 from public.leads where organization_id = $1", [orgB])).toBe(0);
      expect(await count(q, "select 1 from public.organizations where id = $1", [orgB])).toBe(0);
    });
  });
});

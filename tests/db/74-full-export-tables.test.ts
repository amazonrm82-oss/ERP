import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPORT_TABLES, exportKey } from "@/features/imports/export-build";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline } from "./helpers";

afterAll(closePool);

// Every table that holds a business's rows is either in the full export or left
// out on purpose, with the reason here. A new tenant table fails this test until
// someone decides (meetings were missed once; BACKLOG follow-up of CAL-01).
const LEFT_OUT: Record<string, string> = {
  audit_log: "history; the audit log screen exports it",
  automations: "configuration that points at ids; not part of SPEC 12.4 yet",
  automation_runs: "engine log",
  forms: "configuration with public tokens",
  form_submissions: "raw inquiries; the leads they made are exported",
  import_jobs: "engine bookkeeping",
  invitations: "carry secret tokens",
  list_preferences: "a person's screen settings",
  memberships: "people come in as names next to their ids",
  member_permissions: "access settings of the team, like memberships; the audit log keeps every change",
  notifications: "a person's bell",
  org_usage: "server counters",
  outbox_events: "engine queue",
  plan_waitlist: "a person's request to hear about a plan; platform marketing, not business data",
  record_followers: "a person's choice",
  saved_views: "a person's screen settings",
  subscriptions: "billing, server only",
  support_access_grants: "platform support sessions",
};

describe("full export: tables (SPEC 12.4)", () => {
  it("every public table with organization_id is exported or left out on purpose", async () => {
    const tables = await asAdmin(async (q) =>
      (
        await q<{ table_name: string }>(
          `select c.table_name
             from information_schema.columns c
             join information_schema.tables t using (table_schema, table_name)
            where c.table_schema = 'public' and c.column_name = 'organization_id' and t.table_type = 'BASE TABLE'
            order by 1`,
        )
      ).rows.map((r) => r.table_name),
    );
    const exported = new Set<string>(EXPORT_TABLES.map((t) => t.table));
    expect(tables.filter((t) => !exported.has(t) && !(t in LEFT_OUT))).toEqual([]);
    // nothing is both, and nothing listed is gone
    expect(Object.keys(LEFT_OUT).filter((t) => exported.has(t) || !tables.includes(t))).toEqual([]);
    expect([...exported].filter((t) => !tables.includes(t))).toEqual([]);
  });

  it("every exported table pages by created_at and a key that is unique in it", async () => {
    // a key that is not unique would let a row be skipped or repeated between pages (FXC-07)
    const keys = await asAdmin(async (q) =>
      (
        await q<{ table_name: string; key: string[] }>(
          `select rel.relname as table_name, array_agg(a.attname::text order by a.attname) as key
             from pg_index i
             join pg_class rel on rel.oid = i.indrelid
             join pg_namespace n on n.oid = rel.relnamespace and n.nspname = 'public'
             join pg_attribute a on a.attrelid = rel.oid and a.attnum = any (i.indkey)
            where i.indisunique and i.indpred is null and i.indexprs is null
            group by rel.relname, i.indexrelid`,
        )
      ).rows,
    );
    const columns = await asAdmin(async (q) =>
      (await q<{ table_name: string; column_name: string }>("select table_name, column_name from information_schema.columns where table_schema = 'public'")).rows,
    );
    const problems: string[] = [];
    for (const t of EXPORT_TABLES) {
      const have = new Set(columns.filter((c) => c.table_name === t.table).map((c) => c.column_name));
      for (const c of ["organization_id", "created_at", ...exportKey(t)]) if (!have.has(c)) problems.push(`${t.table}.${c} missing`);
      const key = [...exportKey(t)].sort();
      if (!keys.some((k) => k.table_name === t.table && k.key.length === key.length && k.key.every((c, i) => c === key[i]))) {
        problems.push(`${t.table}: (${key.join(", ")}) is not unique`);
      }
    }
    expect(problems).toEqual([]);
  });

  describe("the owner's read of contact channels, deal contacts, team members and WhatsApp templates", () => {
    let owner: { id: string };
    let orgId: string;
    let otherOrg: string;
    let contactId: string;
    let dealId: string;
    let teamId: string;
    let member: { id: string };

    beforeAll(async () => {
      owner = await createUser("export-links-owner");
      orgId = await createOrg(owner.id, "עסק קישורים");
      member = await addMember(orgId, owner.id, "member", "export-links-member");
      const pipe = await defaultPipeline(orgId);
      // the member's own contact and deal; the owner reads them as an admin
      ({ contactId, dealId } = await asUser(member.id, async (q) => {
        const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name, last_name) values ($1, 'רות', 'לוי') returning id", [orgId])).rows[0].id;
        const deal = (
          await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקת ענן', $2, $3) returning id", [
            orgId,
            pipe.pipelineId,
            pipe.stages[0].id,
          ])
        ).rows[0].id;
        await q("insert into public.contact_channels (organization_id, contact_id, kind, label, value) values ($1, $2, 'phone', 'work', '03-1234567')", [orgId, contact]);
        await q("insert into public.deal_contacts (organization_id, deal_id, contact_id, role) values ($1, $2, $3, 'finance')", [orgId, deal, contact]);
        return { contactId: contact, dealId: deal };
      }));
      teamId = await asUser(owner.id, async (q) => {
        const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות דרום') returning id", [orgId])).rows[0].id;
        await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true)", [orgId, team, member.id]);
        return team;
      });

      const stranger = await createUser("export-links-stranger");
      otherOrg = await createOrg(stranger.id, "עסק זר");
      const otherPipe = await defaultPipeline(otherOrg);
      await asUser(stranger.id, async (q) => {
        const contact = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id;
        const deal = (
          await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'לא שלכם', $2, $3) returning id", [
            otherOrg,
            otherPipe.pipelineId,
            otherPipe.stages[0].id,
          ])
        ).rows[0].id;
        await q("insert into public.contact_channels (organization_id, contact_id, kind, value) values ($1, $2, 'email', 'x@example.com')", [otherOrg, contact]);
        await q("insert into public.deal_contacts (organization_id, deal_id, contact_id) values ($1, $2, $3)", [otherOrg, deal, contact]);
        const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'צוות זר') returning id", [otherOrg])).rows[0].id;
        await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [otherOrg, team, stranger.id]);
      });
    });

    // the same read as fetchAll() in src/features/imports/export.ts, ordered by the table's key
    const read = (table: string, org: string) => {
      const entry = EXPORT_TABLES.find((t) => t.table === table);
      if (!entry) throw new Error(`${table} is not exported`);
      const order = ["created_at", ...exportKey(entry)].join(", ");
      return asUser(owner.id, async (q) => (await q(`select * from public.${table} where organization_id = $1 order by ${order} limit 500 offset 0`, [org])).rows);
    };

    it("sees the further phones of the business's contacts", async () => {
      const rows = await read("contact_channels", orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ organization_id: orgId, contact_id: contactId, kind: "phone", label: "work", value: "03-1234567" });
    });

    it("sees the contacts on each deal with their role", async () => {
      const rows = await read("deal_contacts", orgId);
      expect(rows).toEqual([expect.objectContaining({ organization_id: orgId, deal_id: dealId, contact_id: contactId, role: "finance" })]);
    });

    it("sees the team members", async () => {
      const rows = await read("team_members", orgId);
      expect(rows).toEqual([expect.objectContaining({ organization_id: orgId, team_id: teamId, user_id: member.id, is_manager: true })]);
    });

    it("sees the business's WhatsApp templates (the seeded defaults)", async () => {
      const rows = await read("whatsapp_templates", orgId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.organization_id === orgId && typeof r.body === "string")).toBe(true);
    });

    it("sees the business's roles of contacts on a deal (the seeded defaults, CON-03 follow-up)", async () => {
      const rows = await read("deal_contact_roles", orgId);
      expect(rows.map((r) => r.key).sort()).toEqual(["decision_maker", "finance", "influencer", "user"]);
    });

    it("sees nothing of another business", async () => {
      for (const table of ["contact_channels", "deal_contacts", "team_members", "whatsapp_templates", "deal_contact_roles"]) expect(await read(table, otherOrg)).toEqual([]);
    });
  });

  describe("the owner's read of meetings and participants", () => {
    let owner: { id: string };
    let member: { id: string };
    let orgId: string;
    let otherOrg: string;
    let meetingId: string;

    beforeAll(async () => {
      owner = await createUser("export-owner");
      orgId = await createOrg(owner.id, "עסק ייצוא");
      member = await addMember(orgId, owner.id, "member", "export-member");
      const colleague = await addMember(orgId, owner.id, "member", "export-colleague");
      // a member's own meeting with a colleague, no record: the owner reads it as an admin
      meetingId = await asUser(member.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'ישיבת צוות', now() + interval '1 day', now() + interval '1 day 1 hour') returning id",
            [orgId],
          )
        ).rows[0].id,
      );
      await asUser(member.id, (q) =>
        q("insert into public.meeting_participants (organization_id, meeting_id, user_id) values ($1, $2, $3)", [orgId, meetingId, colleague.id]),
      );
      const stranger = await createUser("export-stranger");
      otherOrg = await createOrg(stranger.id, "עסק אחר");
      await asUser(stranger.id, (q) =>
        q("insert into public.meetings (organization_id, title, starts_at, ends_at) values ($1, 'לא שלכם', now(), now() + interval '1 hour')", [otherOrg]),
      );
      await asUser(stranger.id, (q) => q("insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{0}')", [otherOrg]));
    });

    // the same read as fetchAll() in src/features/imports/export.ts
    const read = (table: string, org: string) =>
      asUser(owner.id, async (q) => (await q(`select * from public.${table} where organization_id = $1 order by created_at, id limit 500 offset 0`, [org])).rows);

    it("sees every meeting and participant of the business, with the export's columns", async () => {
      const meetings = await read("meetings", orgId);
      expect(meetings.map((m) => m.id)).toEqual([meetingId]);
      expect(meetings[0]).toMatchObject({ organization_id: orgId, title: "ישיבת צוות", owner_id: member.id });
      const participants = await read("meeting_participants", orgId);
      expect(participants).toHaveLength(1);
      expect(participants[0]).toMatchObject({ meeting_id: meetingId });
      expect(Object.keys(participants[0])).toEqual(expect.arrayContaining(["id", "organization_id", "created_at", "user_id"]));
    });

    it("sees the business's rest days, once set (CAL-03)", async () => {
      expect(await read("org_calendar_settings", orgId)).toEqual([]);
      await asUser(owner.id, (q) =>
        q("insert into public.org_calendar_settings (organization_id, rest_weekdays, rest_occasions) values ($1, '{6}', '{mimouna}')", [orgId]),
      );
      const rows = await read("org_calendar_settings", orgId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ organization_id: orgId, rest_weekdays: [6], holidays_rest: true, holiday_eves_rest: false, rest_occasions: ["mimouna"] });
    });

    it("sees nothing of another business", async () => {
      expect(await read("meetings", otherOrg)).toEqual([]);
      expect(await read("meeting_participants", otherOrg)).toEqual([]);
      expect(await read("org_calendar_settings", otherOrg)).toEqual([]);
    });
  });
});

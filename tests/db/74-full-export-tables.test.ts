import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EXPORT_TABLES } from "@/features/imports/export-build";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

// Every table that holds a business's rows is either in the full export or left
// out on purpose, with the reason here. A new tenant table fails this test until
// someone decides (meetings were missed once; BACKLOG follow-up of CAL-01).
const LEFT_OUT: Record<string, string> = {
  audit_log: "history; the audit log screen exports it",
  automations: "configuration that points at ids; not part of SPEC 12.4 yet",
  automation_runs: "engine log",
  contact_channels: "further phones and emails of a contact; not yet (follow-up)",
  deal_contacts: "links between deals and contacts; not yet (follow-up)",
  forms: "configuration with public tokens",
  form_submissions: "raw inquiries; the leads they made are exported",
  import_jobs: "engine bookkeeping",
  invitations: "carry secret tokens",
  list_preferences: "a person's screen settings",
  memberships: "people come in as names next to their ids",
  notifications: "a person's bell",
  org_calendar_settings: "not yet (follow-up of CAL-03)",
  org_usage: "server counters",
  outbox_events: "engine queue",
  record_followers: "a person's choice",
  saved_views: "a person's screen settings",
  subscriptions: "billing, server only",
  support_access_grants: "platform support sessions",
  team_members: "not yet (follow-up)",
  whatsapp_templates: "not yet (follow-up)",
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

    it("sees nothing of another business", async () => {
      expect(await read("meetings", otherOrg)).toEqual([]);
      expect(await read("meeting_participants", otherOrg)).toEqual([]);
    });
  });
});

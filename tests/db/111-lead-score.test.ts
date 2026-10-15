import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const HINT = "lead_score_rule:invalid";

const scoreOf = (lead: string) => asAdmin(async (q) => (await q<{ s: number }>("select score as s from public.leads where id = $1", [lead])).rows[0].s);

const addRule = (userId: string, org: string, field: string, op: string, value: string | null, points: number) =>
  asUser(userId, async (q) =>
    (
      await q<{ id: string }>("insert into public.lead_score_rules (organization_id, field, op, value, points) values ($1, $2, $3, $4, $5) returning id", [
        org,
        field,
        op,
        value,
        points,
      ])
    ).rows[0].id,
  );

const refresh = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ done: boolean }>("select public.lead_scores_refresh($1) as done", [org])).rows[0].done);

const pending = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ p: boolean | null }>("select public.lead_scores_pending($1) as p", [org])).rows[0].p);

const suggest = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ n: number }>("select public.lead_score_rules_suggest($1) as n", [org])).rows[0].n);

// the rules a new business starts with (owner, 14 October 2026)
const SUGGESTED = [
  { field: "email", op: "filled", value: null, points: 10, position: 0, is_active: true },
  { field: "phone", op: "filled", value: null, points: 10, position: 1, is_active: true },
  { field: "activity:call", op: "gte", value: "1", points: 10, position: 2, is_active: true },
  { field: "activity:meeting", op: "gte", value: "1", points: 20, position: 3, is_active: true },
  { field: "callback", op: "filled", value: null, points: 15, position: 4, is_active: true },
];

const rulesOf = (org: string) =>
  asAdmin(async (q) =>
    (await q("select field, op, value, points, position, is_active from public.lead_score_rules where organization_id = $1 order by position, created_at", [org])).rows,
  );

// a zone where it is about noon now, so a slot tomorrow 12:00-15:00 is always offered (as in test 72)
function noonZone(at = new Date()): string {
  const offset = 12 - at.getUTCHours();
  return offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

// LEAD-05: the score is the sum of the points of the business's active rules that a lead matches.
describe("lead score (LEAD-05)", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U;
  let org: string;
  let otherOrg: string;
  let sourceId: string;
  let otherSource: string;
  let otherStatus: string;
  let tagId: string;

  beforeAll(async () => {
    owner = await createUser("ls-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "ls-admin");
    manager = await addMember(org, owner.id, "manager", "ls-manager");
    member = await addMember(org, owner.id, "member", "ls-member");
    viewer = await addMember(org, owner.id, "viewer", "ls-viewer");
    const stranger = await createUser("ls-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await asAdmin(async (q) => {
      // these tests build their own rules: start from none
      await q("delete from public.lead_score_rules where organization_id = $1", [org]);
      await q("select app.recompute_lead_scores()");
      sourceId = (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 order by created_at limit 1", [org])).rows[0].id;
      otherSource = (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 limit 1", [otherOrg])).rows[0].id;
      otherStatus = (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 limit 1", [otherOrg])).rows[0].id;
      tagId = (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'חם') returning id", [org])).rows[0].id;
      await q(
        `insert into public.field_definitions (organization_id, object_type, key, label, field_type, options) values
           ($1, 'lead', 'size', 'גודל', 'select', '["קטן", "גדול"]'),
           ($1, 'lead', 'employees', 'עובדים', 'number', '[]'),
           ($1, 'lead', 'vip', 'VIP', 'checkbox', '[]'),
           ($1, 'lead', 'notes2', 'הערה', 'text', '[]')`,
        [org],
      );
    });
  });

  describe("rules: who writes, and what is valid", () => {
    it("owners and admins add rules; everyone in the business reads them; nobody else", async () => {
      const id = await addRule(admin.id, org, "email", "filled", null, 5);
      for (const u of [manager, member, viewer]) {
        const sql = "insert into public.lead_score_rules (organization_id, field, op, points) values ($1, 'phone', 'filled', 5)";
        expect((await pgError(asUser(u.id, (q) => q(sql, [org])))).code, u.email).toBe("42501");
        expect(await asUser(u.id, (q) => count(q, "select 1 from public.lead_score_rules where id = $1", [id])), u.email).toBe(1);
        expect((await asUser(u.id, (q) => q("update public.lead_score_rules set points = 50 where id = $1", [id]))).rowCount, u.email).toBe(0);
        expect((await asUser(u.id, (q) => q("delete from public.lead_score_rules where id = $1", [id]))).rowCount, u.email).toBe(0);
      }
      const stranger = await createUser("ls-outsider");
      expect(await asUser(stranger.id, (q) => count(q, "select 1 from public.lead_score_rules where organization_id = $1", [org]))).toBe(0);
      expect((await pgError(asUser(stranger.id, (q) => q("insert into public.lead_score_rules (organization_id, field, op, points) values ($1, 'phone', 'filled', 5)", [org])))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q("select 1 from public.lead_score_rules")))).code).toBe("42501");
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where id = $1", [id]));
    });

    it("refuses a rule that does not fit its field", async () => {
      const bad: Array<[string, string, string | null]> = [
        ["source", "eq", otherSource], // another organization's source
        ["status", "eq", otherStatus],
        ["source", "filled", null],
        ["tag", "gte", "1"],
        ["email", "eq", "x@example.test"],
        ["budget", "gte", "abc"],
        ["activity:call", "lte", "2"],
        ["activity:call", "gte", "0"],
        ["activity:call", "gte", "101"],
        ["activity:status_change", "gte", "1"],
        ["cf:missing", "filled", null],
        ["cf:size", "eq", "בינוני"],
        ["cf:vip", "filled", null],
        ["cf:vip", "neq", "true"],
        ["cf:notes2", "gte", "3"],
        ["cf:employees", "gte", "many"],
      ];
      for (const [field, op, value] of bad) {
        const error = await pgError(addRule(admin.id, org, field, op, value, 5));
        expect(error.hint, `${field} ${op} ${value}`).toBe(HINT);
      }
      // the table's own checks
      expect((await pgError(addRule(admin.id, org, "email", "filled", null, 0))).code).toBe("23514");
      expect((await pgError(addRule(admin.id, org, "email", "filled", null, 101))).code).toBe("23514");
      // an unknown field: the rule check runs before the table's own checks
      expect((await pgError(addRule(admin.id, org, "full_name", "filled", null, 5))).hint).toBe(HINT);
      expect(await asAdmin((q) => count(q, "select 1 from public.lead_score_rules where organization_id = $1", [org]))).toBe(0);
    });

    it("keeps at most 50 rules per business", async () => {
      const cap = await createUser("ls-cap");
      const capOrg = await createOrg(cap.id);
      // the five suggested rules count too
      await asAdmin((q) =>
        q("insert into public.lead_score_rules (organization_id, field, op, points) select $1, 'email', 'filled', 1 from generate_series(1, 45)", [capOrg]),
      );
      expect((await pgError(addRule(cap.id, capOrg, "phone", "filled", null, 1))).hint).toBe("lead_score_rules:max");
    });
  });

  describe("the score", () => {
    it("is never written by a person", async () => {
      const lead = await insertLead(member.id, org, { full_name: "ליד" });
      expect((await pgError(asUser(member.id, (q) => q("update public.leads set score = 99 where id = $1", [lead])))).code).toBe("42501");
      expect((await pgError(insertLead(member.id, org, { full_name: "ליד", score: 99 }))).code).toBe("42501");
      // even a server write gets the computed value
      await asAdmin((q) => q("update public.leads set score = 99 where id = $1", [lead]));
      expect(await scoreOf(lead)).toBe(0);
    });

    it("follows the fields of the lead on every write", async () => {
      const rules = [
        await addRule(admin.id, org, "source", "eq", sourceId, 10),
        await addRule(admin.id, org, "email", "filled", null, 5),
        await addRule(admin.id, org, "budget", "gte", "100000", 20),
        await addRule(admin.id, org, "tag", "eq", tagId, 7),
        await addRule(admin.id, org, "cf:size", "eq", "גדול", 15),
        await addRule(admin.id, org, "cf:employees", "gte", "50", 3),
        await addRule(admin.id, org, "cf:vip", "eq", "false", -4),
        await addRule(admin.id, org, "phone", "empty", null, -2),
      ];
      const lead = await insertLead(member.id, org, { full_name: "ליד שדות" });
      // no phone (-2), the box not ticked (-4)
      expect(await scoreOf(lead)).toBe(-6);
      await asUser(member.id, (q) =>
        q(
          `update public.leads set source_id = $2, email = 'a@example.test', phone = '050-1234567', budget_agorot = 150000,
             custom_fields = '{"$merge": {"size": "גדול", "employees": 80, "vip": true}}' where id = $1`,
          [lead, sourceId],
        ),
      );
      expect(await scoreOf(lead)).toBe(10 + 5 + 20 + 15 + 3);
      await asUser(member.id, (q) => q("select public.change_record_tags('leads', $1, $2, $3, '{}')", [org, lead, [tagId]]));
      expect(await scoreOf(lead)).toBe(60);
      // an inactive rule no longer counts once the leads are recomputed
      await asUser(admin.id, (q) => q("update public.lead_score_rules set is_active = false where id = $1", [rules[2]]));
      expect(await scoreOf(lead)).toBe(60);
      expect(await pending(member.id, org)).toBe(true);
      expect(await refresh(admin.id, org)).toBe(true);
      expect(await scoreOf(lead)).toBe(40);
      expect(await pending(member.id, org)).toBe(false);
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      expect(await refresh(owner.id, org)).toBe(true);
      expect(await scoreOf(lead)).toBe(0);
    });

    it("follows the timeline, without making it an edit of the lead", async () => {
      await addRule(admin.id, org, "activity:call", "gte", "2", 10);
      await addRule(admin.id, org, "activity:note", "gte", "1", 1);
      const lead = await insertLead(member.id, org, { full_name: "ליד שיחות" });
      const before = await asAdmin(async (q) => (await q<{ u: string; b: string | null }>("select updated_at::text as u, updated_by::text as b from public.leads where id = $1", [lead])).rows[0]);
      const log = (type: string, privateNote = false) =>
        asUser(member.id, async (q) =>
          (await q<{ id: string }>("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, $2, 'x', $3, $4) returning id", [org, type, lead, privateNote]))
            .rows[0].id,
        );
      await log("call");
      expect(await scoreOf(lead)).toBe(0);
      const second = await log("call");
      expect(await scoreOf(lead)).toBe(10);
      // a private note never counts
      await log("note", true);
      expect(await scoreOf(lead)).toBe(10);
      await log("note");
      expect(await scoreOf(lead)).toBe(11);
      const after = await asAdmin(async (q) => (await q<{ u: string; b: string | null }>("select updated_at::text as u, updated_by::text as b from public.leads where id = $1", [lead])).rows[0]);
      expect(after).toEqual(before);
      // the score is not a change of the lead: no event and no audit entry names it
      expect(
        await asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = $1 and event_type = 'lead.updated' and payload -> 'changed' ? 'score'", [lead])),
      ).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1 and changes ? 'score'", [lead]))).toBe(0);
      // deleting an entry takes the points off again
      await asAdmin((q) => q("delete from public.activities where id = $1", [second]));
      expect(await scoreOf(lead)).toBe(1);
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      await refresh(owner.id, org);
    });

    it("recomputes a whole business in the background after a rule change", async () => {
      const leads = await Promise.all([1, 2, 3].map((n) => insertLead(member.id, org, { full_name: `ליד ${n}`, email: `l${n}@example.test` })));
      await addRule(admin.id, org, "email", "filled", null, 8);
      expect(await scoreOf(leads[0])).toBe(0);
      // the job takes the oldest five waiting businesses a run: other test files may have some waiting
      for (let run = 0; run < 50 && (await pending(member.id, org)); run++) await asAdmin((q) => q("select app.recompute_lead_scores()"));
      for (const lead of leads) expect(await scoreOf(lead)).toBe(8);
      expect(await pending(member.id, org)).toBe(false);
      // a lead in the recycle bin is left alone; restoring it recomputes it
      await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [leads[0]]));
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      for (let run = 0; run < 50 && (await pending(member.id, org)); run++) await asAdmin((q) => q("select app.recompute_lead_scores()"));
      expect(await pending(member.id, org)).toBe(false);
      expect(await scoreOf(leads[0])).toBe(8);
      expect(await scoreOf(leads[1])).toBe(0);
      await asAdmin((q) => q("update public.leads set deleted_at = null where id = $1", [leads[0]]));
      expect(await scoreOf(leads[0])).toBe(0);
    });

    it("a score-only change writes no audit entry and no event; a real edit lists only what the person changed", async () => {
      const lead = await insertLead(member.id, org, { full_name: "ליד ביקורת", email: "audit@example.test" });
      await addRule(admin.id, org, "email", "filled", null, 7);
      const audits = () => asAdmin((q) => count(q, "select 1 from public.audit_log where entity_id = $1", [lead]));
      const outbox = () => asAdmin((q) => count(q, "select 1 from public.outbox_events where entity_id = $1", [lead]));
      const [auditBefore, outboxBefore] = [await audits(), await outbox()];
      expect(await refresh(admin.id, org)).toBe(true);
      expect(await scoreOf(lead)).toBe(7);
      expect(await audits()).toBe(auditBefore);
      expect(await outbox()).toBe(outboxBefore);
      // a person clears the email: the score drops with it, and only the email is the change
      await asUser(member.id, (q) => q("update public.leads set email = null where id = $1", [lead]));
      expect(await scoreOf(lead)).toBe(0);
      const audit = await asAdmin(async (q) =>
        (await q<{ keys: string[] }>("select array(select jsonb_object_keys(changes)) as keys from public.audit_log where entity_id = $1 and action = 'update' order by created_at desc limit 1", [lead])).rows[0],
      );
      expect(audit.keys).toEqual(["email"]);
      const event = await asAdmin(async (q) =>
        (await q<{ changed: string[] }>("select payload -> 'changed' as changed from public.outbox_events where entity_id = $1 and event_type = 'lead.updated' order by created_at desc limit 1", [lead])).rows[0],
      );
      expect(event.changed).toEqual(["email"]);
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      await refresh(owner.id, org);
    });

    it("a rule whose source, status, tag or option was removed matches nothing, even 'is not'", async () => {
      const ro = await createUser("ls-gone");
      const gOrg = await createOrg(ro.id);
      const ids = await asAdmin(async (q) => {
        await q("delete from public.lead_score_rules where organization_id = $1", [gOrg]);
        await q("insert into public.field_definitions (organization_id, object_type, key, label, field_type, options) values ($1, 'lead', 'tier', 'דרג', 'select', '[\"א\", \"ב\"]')", [gOrg]);
        return {
          source: (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'מקור זמני') returning id", [gOrg])).rows[0].id,
          status: (await q<{ id: string }>("insert into public.lead_statuses (organization_id, name, kind, position) values ($1, 'סטטוס זמני', 'open', 99) returning id", [gOrg])).rows[0].id,
          tag: (await q<{ id: string }>("insert into public.tags (organization_id, name) values ($1, 'תגית זמנית') returning id", [gOrg])).rows[0].id,
        };
      });
      await addRule(ro.id, gOrg, "source", "neq", ids.source, 1);
      await addRule(ro.id, gOrg, "status", "neq", ids.status, 2);
      await addRule(ro.id, gOrg, "tag", "neq", ids.tag, 4);
      await addRule(ro.id, gOrg, "cf:tier", "neq", "ב", 8);
      const lead = await insertLead(ro.id, gOrg, { full_name: "ליד", custom_fields: { tier: "א" } });
      expect(await scoreOf(lead)).toBe(15);
      await asAdmin(async (q) => {
        await q("delete from public.lead_sources where id = $1", [ids.source]);
        await q("delete from public.lead_statuses where id = $1", [ids.status]);
        await q("delete from public.tags where id = $1", [ids.tag]);
        await q("update public.field_definitions set options = '[\"א\"]' where organization_id = $1 and key = 'tier'", [gOrg]);
      });
      await refresh(ro.id, gOrg);
      expect(await scoreOf(lead)).toBe(0);
      const card = await asUser(ro.id, async (q) => (await q<{ b: { matched: unknown[] } }>("select public.lead_score_breakdown($1, $2) as b", [gOrg, lead])).rows[0].b);
      expect(card.matched).toEqual([]);
    });

    it("a recompute never keeps a score computed from a row someone else is changing", async () => {
      const lead = await insertLead(member.id, org, { full_name: "ליד מרוץ", email: "race@example.test" });
      // a new rule: the lead's stored score (0) is not recomputed yet, its row would score 6
      await addRule(admin.id, org, "email", "filled", null, 6);
      expect(await scoreOf(lead)).toBe(0);
      const a = new Client({ connectionString: TEST_DB_URL });
      const b = new Client({ connectionString: TEST_DB_URL });
      await a.connect();
      await b.connect();
      try {
        await b.query("set statement_timeout = 10000");
        // session A clears the email and has not committed; a single-lead recompute waits for it and sees its row
        await a.query("begin");
        await a.query("update public.leads set email = null where id = $1", [lead]);
        const write = b.query("select app.lead_score_write($1, $2)", [org, lead]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await a.query("commit");
        await write;
        expect(await scoreOf(lead)).toBe(0);

        // the background pass skips a lead someone is writing, and the business stays queued
        await a.query("begin");
        await a.query("update public.leads set email = 'back@example.test' where id = $1", [lead]);
        await b.query("select app.lead_score_enqueue($1)", [org]);
        const done = (await b.query<{ done: boolean }>("select app.lead_scores_batch($1, 1000) as done", [org])).rows[0].done;
        expect(done).toBe(false);
        expect(await pending(member.id, org)).toBe(true);
        await a.query("commit");
        expect(await scoreOf(lead)).toBe(6);
        let finished = false;
        for (let run = 0; run < 5 && !finished; run++) finished = await refresh(admin.id, org);
        expect(finished).toBe(true);
        expect(await pending(member.id, org)).toBe(false);
        expect(await scoreOf(lead)).toBe(6);
      } finally {
        await a.end();
        await b.end();
      }
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      await refresh(owner.id, org);
    });

    it("a rule never moves to another business, even for an admin of both", async () => {
      const second = await createOrg(owner.id, "עסק שני");
      const id = await addRule(admin.id, org, "email", "filled", null, 3);
      expect((await pgError(asUser(owner.id, (q) => q("update public.lead_score_rules set organization_id = $2 where id = $1", [id, second])))).code).toBe("42501");
      expect(await asAdmin(async (q) => (await q<{ o: string }>("select organization_id as o from public.lead_score_rules where id = $1", [id])).rows[0].o)).toBe(org);
      // its own parts stay editable
      expect((await asUser(owner.id, (q) => q("update public.lead_score_rules set points = 4, is_active = false where id = $1", [id]))).rowCount).toBe(1);
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      await refresh(owner.id, org);
    });

    it("a read-only business cannot start a recompute", async () => {
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      expect(await pgError(refresh(owner.id, org))).toMatchObject({ code: "P0001", hint: "org:read_only" });
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    });

    it("only owners and admins start a recompute; members may ask whether one waits", async () => {
      for (const u of [manager, member, viewer]) {
        expect((await pgError(refresh(u.id, org))).code, u.email).toBe("42501");
      }
      const stranger = await createUser("ls-peek");
      expect(await pending(stranger.id, org)).toBeNull();
      expect((await pgError(refresh(stranger.id, org))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q("select public.lead_scores_pending($1)", [org])))).code).toBe("42501");
    });

    it("a hidden custom field stops its rule", async () => {
      const lead = await insertLead(member.id, org, { full_name: "ליד שדה", custom_fields: { size: "קטן" } });
      await addRule(admin.id, org, "cf:size", "eq", "קטן", 9);
      await refresh(admin.id, org);
      expect(await scoreOf(lead)).toBe(9);
      await asUser(owner.id, (q) => q("update public.field_definitions set is_active = false where organization_id = $1 and key = 'size'", [org]));
      expect(await pending(member.id, org)).toBe(true);
      await refresh(admin.id, org);
      expect(await scoreOf(lead)).toBe(0);
      await asUser(owner.id, (q) => q("update public.field_definitions set is_active = true where organization_id = $1 and key = 'size'", [org]));
      await refresh(admin.id, org);
      expect(await scoreOf(lead)).toBe(9);
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      await refresh(owner.id, org);
    });
  });

  describe("why a lead has its score", () => {
    it("lists the matched rules to whoever reads the lead, and nothing to anyone else", async () => {
      const email = await addRule(admin.id, org, "email", "filled", null, 4);
      await addRule(admin.id, org, "phone", "filled", null, 6);
      const lead = await insertLead(member.id, org, { full_name: "ליד הסבר", email: "why@example.test", owner_id: member.id });
      const breakdown = (userId: string) =>
        asUser(userId, async (q) => (await q<{ b: { score: number; matched: Array<{ id: string; points: number }> } | null }>("select public.lead_score_breakdown($1, $2) as b", [org, lead])).rows[0].b);
      expect(await breakdown(member.id)).toEqual({ score: 4, matched: [{ id: email, points: 4 }] });
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      const other = await addMember(org, owner.id, "member", "ls-other");
      expect(await breakdown(other.id)).toBeNull();
      const stranger = await createUser("ls-why");
      expect(await breakdown(stranger.id)).toBeNull();
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      await asUser(owner.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [org]));
      await refresh(owner.id, org);
    });
  });

  describe("suggested rules", () => {
    it("a new business starts with the five suggested rules, and a lead is scored by them", async () => {
      const u = await createUser("ls-new");
      const fresh = await createOrg(u.id);
      expect(await rulesOf(fresh)).toEqual(SUGGESTED);
      const lead = await insertLead(u.id, fresh, { full_name: "ליד ראשון", email: "first@example.test", phone: "050-1111111" });
      expect(await scoreOf(lead)).toBe(20);
      await asUser(u.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'meeting', 'x', $2)", [fresh, lead]));
      expect(await scoreOf(lead)).toBe(40);
      // they are the business's own rules: it may delete them
      expect((await asUser(u.id, (q) => q("delete from public.lead_score_rules where organization_id = $1 and field = 'phone'", [fresh]))).rowCount).toBe(1);
    });

    it("the button adds them only for owners and admins of a writable business with no rules", async () => {
      const so = await createUser("ls-sugg-owner");
      const sorg = await createOrg(so.id);
      const sadmin = await addMember(sorg, so.id, "admin", "ls-sugg-admin");
      const smembers = [
        await addMember(sorg, so.id, "manager", "ls-sugg-manager"),
        await addMember(sorg, so.id, "member", "ls-sugg-member"),
        await addMember(sorg, so.id, "viewer", "ls-sugg-viewer"),
      ];
      await asUser(so.id, (q) => q("delete from public.lead_score_rules where organization_id = $1", [sorg]));
      await asAdmin((q) => q("select app.recompute_lead_scores()"));
      const lead = await insertLead(smembers[1].id, sorg, { full_name: "ליד קיים", email: "old@example.test" });
      expect(await scoreOf(lead)).toBe(0);

      for (const u of smembers) {
        expect((await pgError(suggest(u.id, sorg))).code, u.email).toBe("42501");
      }
      // another business's owner, and nobody signed in
      const otherOwner = await createUser("ls-sugg-other");
      const ownOrg = await createOrg(otherOwner.id, "עסק שכן");
      expect((await pgError(suggest(otherOwner.id, sorg))).code).toBe("42501");
      expect((await pgError(asAnon((q) => q("select public.lead_score_rules_suggest($1)", [sorg])))).code).toBe("42501");
      expect(await rulesOf(ownOrg)).toEqual(SUGGESTED);
      // a read-only business changes nothing
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [sorg]));
      expect(await pgError(suggest(so.id, sorg))).toMatchObject({ code: "P0001", hint: "org:read_only" });
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [sorg]));
      expect(await rulesOf(sorg)).toEqual([]);

      expect(await suggest(sadmin.id, sorg)).toBe(5);
      expect(await rulesOf(sorg)).toEqual(SUGGESTED);
      // a second click, or a business that has any rule, adds nothing
      expect(await suggest(so.id, sorg)).toBe(0);
      await asUser(so.id, (q) => q("delete from public.lead_score_rules where organization_id = $1 and field <> 'email'", [sorg]));
      expect(await suggest(so.id, sorg)).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from public.lead_score_rules where organization_id = $1", [sorg]))).toBe(1);
      // the existing leads are rescored through the queue
      expect(await pending(smembers[1].id, sorg)).toBe(true);
      expect(await refresh(so.id, sorg)).toBe(true);
      expect(await scoreOf(lead)).toBe(10);
    });
  });

  describe("a call-back asked for in a form", () => {
    let cbOwner: U, cbMember: U;
    let cbOrg: string;
    let token: string;
    const zone = noonZone();
    const submit = (payload: Record<string, unknown>) =>
      asService(async (q) => (await q<{ r: { status: string; lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify(payload)])).rows[0].r);
    const tomorrowNoon = async () =>
      `${await asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone $1)::date + 1, 'YYYY-MM-DD') as d", [zone])).rows[0].d)}-12`;
    const marks = (lead: string) => asAdmin((q) => count(q, "select 1 from app.lead_callback_requests where lead_id = $1", [lead]));

    beforeAll(async () => {
      cbOwner = await createUser("ls-cb-owner");
      cbOrg = await createOrg(cbOwner.id);
      cbMember = await addMember(cbOrg, cbOwner.id, "member", "ls-cb-member");
      await asUser(cbOwner.id, async (q) => {
        await q("update public.organizations set timezone = $2 where id = $1", [cbOrg, zone]);
        await q("insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest) values ($1, '{}', false)", [cbOrg]);
        token = (
          await q<{ token: string }>(
            "insert into public.forms (organization_id, name, title, owner_id, callback_choice) values ($1, 'חזרה', 'פנייה', $2, true) returning token",
            [cbOrg, cbMember.id],
          )
        ).rows[0].token;
      });
    });

    it("scores a new lead that asked for a call-back, and not one that did not", async () => {
      const asked = await submit({ full_name: "ביקש", phone: "050-8100001", callback: await tomorrowNoon() });
      expect(asked.status).toBe("accepted");
      // phone +10, call-back +15
      expect(await scoreOf(asked.lead_id)).toBe(25);
      expect(await marks(asked.lead_id)).toBe(1);
      const plain = await submit({ full_name: "לא ביקש", phone: "050-8100002" });
      expect(await scoreOf(plain.lead_id)).toBe(10);
      expect(await marks(plain.lead_id)).toBe(0);
      // the mark belongs to the lead, not to the call task
      await asAdmin((q) => q("delete from public.tasks where organization_id = $1 and lead_id = $2", [cbOrg, asked.lead_id]));
      await asAdmin((q) => q("select app.lead_score_enqueue($1)", [cbOrg]));
      await refresh(cbOwner.id, cbOrg);
      expect(await scoreOf(asked.lead_id)).toBe(25);
    });

    it("a repeat inquiry with a call-back scores the existing lead once", async () => {
      const lead = await insertLead(cbMember.id, cbOrg, { full_name: "לקוח קיים", phone: "050-8100003" });
      expect(await scoreOf(lead)).toBe(10);
      const r = await submit({ full_name: "לקוח קיים", phone: "0508100003", callback: await tomorrowNoon() });
      expect(r).toMatchObject({ status: "duplicate", lead_id: lead });
      expect(await scoreOf(lead)).toBe(25);
      await submit({ full_name: "לקוח קיים", phone: "0508100003", callback: await tomorrowNoon() });
      expect(await marks(lead)).toBe(1);
      expect(await scoreOf(lead)).toBe(25);
    });

    it("the card lists the call-back rule to whoever reads the lead; the helper tells nobody else", async () => {
      const r = await submit({ full_name: "הסבר", phone: "050-8100004", callback: await tomorrowNoon() });
      const callbackRule = await asAdmin(async (q) =>
        (await q<{ id: string }>("select id from public.lead_score_rules where organization_id = $1 and field = 'callback'", [cbOrg])).rows[0].id,
      );
      const card = await asUser(cbOwner.id, async (q) =>
        (await q<{ b: { score: number; matched: Array<{ id: string; points: number }> } }>("select public.lead_score_breakdown($1, $2) as b", [cbOrg, r.lead_id])).rows[0].b,
      );
      expect(card.score).toBe(25);
      expect(card.matched).toContainEqual({ id: callbackRule, points: 15 });
      const helper = (userId: string) =>
        asUser(userId, async (q) => (await q<{ b: boolean }>("select app.lead_callback_requested($1, $2) as b", [cbOrg, r.lead_id])).rows[0].b);
      expect(await helper(cbOwner.id)).toBe(true);
      expect(await helper((await createUser("ls-cb-peek")).id)).toBe(false);
      // and nobody reads the marks directly
      expect((await pgError(asUser(cbOwner.id, (q) => q("select 1 from app.lead_callback_requests")))).code).toBe("42501");
    });

    it("a merge keeps the duplicate's call-back for the kept lead", async () => {
      const asked = await submit({ full_name: "כפול", phone: "050-8100005", callback: await tomorrowNoon() });
      expect(await scoreOf(asked.lead_id)).toBe(25);
      const keep = await insertLead(cbMember.id, cbOrg, { full_name: "כפול", phone: "050-8100006" });
      expect(await scoreOf(keep)).toBe(10);
      await asUser(cbOwner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [cbOrg, keep, asked.lead_id]));
      expect(await marks(keep)).toBe(1);
      expect(await scoreOf(keep)).toBe(25);
      // both asked: still one mark, the earliest time
      const again = await submit({ full_name: "כפול שני", phone: "050-8100007", callback: await tomorrowNoon() });
      const firstAt = await asAdmin(async (q) => (await q<{ t: Date }>("select requested_at as t from app.lead_callback_requests where lead_id = $1", [keep])).rows[0].t);
      await asUser(cbOwner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}')", [cbOrg, keep, again.lead_id]));
      expect(await marks(keep)).toBe(1);
      const at = await asAdmin(async (q) => (await q<{ t: Date }>("select requested_at as t from app.lead_callback_requests where lead_id = $1", [keep])).rows[0].t);
      expect(at.toISOString()).toBe(firstAt.toISOString());
      expect(await scoreOf(keep)).toBe(25);
    });

    it("a call-back rule takes no value and no other condition", async () => {
      for (const [op, value] of [["eq", "true"], ["gte", "1"], ["filled", "1"]] as const) {
        expect((await pgError(addRule(cbOwner.id, cbOrg, "callback", op, value, 5))).hint, op).toBe(HINT);
      }
      const id = await addRule(cbOwner.id, cbOrg, "callback", "empty", null, -3);
      const lead = await insertLead(cbMember.id, cbOrg, { full_name: "בלי בקשה" });
      expect(await scoreOf(lead)).toBe(-3);
      await asUser(cbOwner.id, (q) => q("delete from public.lead_score_rules where id = $1", [id]));
    });
  });

  describe("sample data", () => {
    it("a sample lead whose score moved with the rules is still removed", async () => {
      const so = await createUser("ls-sample");
      const sampleOrg = await createOrg(so.id);
      await asUser(so.id, (q) => q("select public.sample_data_add($1)", [sampleOrg]));
      await addRule(so.id, sampleOrg, "email", "filled", null, 30);
      await addRule(so.id, sampleOrg, "phone", "filled", null, 30);
      await refresh(so.id, sampleOrg);
      expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1 and score > 0", [sampleOrg]))).toBeGreaterThan(0);
      const res = await asUser(so.id, (q) => q<{ r: { removed: number; kept: number } }>("select public.sample_data_remove($1) as r", [sampleOrg]));
      expect(res.rows[0].r.kept).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from public.leads where organization_id = $1", [sampleOrg]))).toBe(0);
    });
  });
});

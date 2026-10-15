import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";
import { migrationFile, rerunClosure } from "./rerun";

afterAll(closePool);

// Re-running this migration puts back its own functions. Every later migration that redefines one of them runs
// again after it, and every later migration that redefines a function of THOSE files, and so on (rerunClosure:
// 0118 brings app.sample_untouched, whose later files bring app.merge_move_links, whose last body is in
// lead_score). deal_lines (DLI-01) is one of them and revokes the table's client grants, so every later migration
// that grants a deal_lines column again (DLI-04 billing) runs too.
const RERUN = rerunClosure([migrationFile("_activation_metric.sql")], (sql) => /^grant [^;]* on public\.deal_lines to authenticated/im.test(sql));
const rerun = (): Promise<void> =>
  asAdmin(async (q) => {
    for (const sql of RERUN.sql) await q(sql);
  });

type U = { id: string; email: string };
type Activation = { activated_at: Date; lead_created_at: Date } | undefined;

const activation = (org: string): Promise<Activation> =>
  asAdmin(async (q) =>
    (await q<{ activated_at: Date; lead_created_at: Date }>("select activated_at, lead_created_at from app.org_activation where organization_id = $1", [org])).rows[0],
  );

/** A lead created `hoursAgo` hours ago (as the server would have stamped it then). */
const oldLead = async (userId: string, org: string, hoursAgo: number, fields: Record<string, unknown> = {}) => {
  const id = await insertLead(userId, org, fields);
  await asAdmin(async (q) => {
    await q("set local session_replication_role = replica");
    await q("update public.leads set created_at = now() - make_interval(hours => $2) where id = $1", [id, hoursAgo]);
  });
  return id;
};

/** An entry logged by a person in the app (the live triggers run). */
const logEntry = (userId: string, org: string, lead: string, opts: { type?: string; hoursAgo?: number; isPrivate?: boolean } = {}) =>
  asUser(userId, async (q) =>
    (
      await q<{ id: string }>(
        "insert into public.activities (organization_id, type, body, lead_id, occurred_at, is_private) values ($1, $2, 'שיחה', $3, now() - make_interval(hours => $4), $5) returning id",
        [org, opts.type ?? "call", lead, opts.hoursAgo ?? 0, opts.isPrivate ?? false],
      )
    ).rows[0].id,
  );

describe("activation metric (GAP-06)", () => {
  let owner: U;

  // a user may own at most 5 organizations: a fresh owner for every test
  beforeEach(async () => {
    owner = await createUser("act-owner");
  });

  it("the first real lead answered within 24 hours marks the organization, once", async () => {
    const org = await createOrg(owner.id, "עסק שמתחיל");
    const member = await addMember(org, owner.id, "member", "act-member");
    expect(await activation(org)).toBeUndefined();

    const lead = await insertLead(member.id, org);
    await logEntry(member.id, org, lead);
    const first = await activation(org);
    expect(first).toBeDefined();
    const leadCreated = await asAdmin(async (q) => (await q<{ c: Date }>("select created_at as c from public.leads where id = $1", [lead])).rows[0].c);
    expect(first!.lead_created_at.getTime()).toBe(leadCreated.getTime());
    expect(first!.activated_at.getTime()).toBeGreaterThanOrEqual(leadCreated.getTime());

    // a later answer on another lead does not move it; deleting the entry does not clear it
    const second = await insertLead(member.id, org);
    const entry = await logEntry(member.id, org, second);
    await asAdmin((q) => q("delete from public.activities where id = $1", [entry]));
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    expect(await activation(org)).toEqual(first);
  });

  it("imported leads, leads in the bin, system entries, planned and non-contact entries do not count", async () => {
    const org = await createOrg(owner.id, "עסק עם ייבוא");

    // imported
    const imported = await asUser(owner.id, async (q) => {
      const job = (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'leads.csv', 'skip') returning id", [org])).rows[0].id;
      const status = (await q<{ id: string }>("select id from public.lead_statuses where organization_id = $1 order by position limit 1", [org])).rows[0].id;
      return (await q<{ id: string }>("insert into public.leads (organization_id, status_id, full_name, import_job_id) values ($1, $2, 'מיובא', $3) returning id", [org, status, job])).rows[0].id;
    });
    await logEntry(owner.id, org, imported);

    // in the recycle bin
    const binned = await insertLead(owner.id, org);
    await asAdmin((q) => q("update public.leads set deleted_at = now() where id = $1", [binned]));
    await logEntry(owner.id, org, binned);

    const lead = await insertLead(owner.id, org);
    // written by the system (no author)
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'מערכת', $2)", [org, lead]));
    // not a contact type
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id, created_by) values ($1, 'status_change', '', $2, $3)", [org, lead, owner.id]));
    // planned for tomorrow
    await logEntry(owner.id, org, lead, { hoursAgo: -24 });
    expect(await activation(org)).toBeUndefined();

    // the same lead answered now counts
    await logEntry(owner.id, org, lead);
    expect(await activation(org)).toBeDefined();
  });

  it("an answer after 24 hours does not count; one dated inside the 24 hours does", async () => {
    const org = await createOrg(owner.id, "עסק איטי");
    const lead = await oldLead(owner.id, org, 48);
    await logEntry(owner.id, org, lead);
    expect(await activation(org)).toBeUndefined();

    // logged now, dated 30 hours ago = 18 hours after the lead arrived
    await logEntry(owner.id, org, lead, { hoursAgo: 30 });
    const row = await activation(org);
    expect(row).toBeDefined();
    expect(row!.activated_at.getTime() - row!.lead_created_at.getTime()).toBeGreaterThan(17.9 * 3_600_000);
    expect(row!.activated_at.getTime() - row!.lead_created_at.getTime()).toBeLessThan(18.1 * 3_600_000);
  });

  it("a lead dated in the future by the client is read as arriving now", async () => {
    const org = await createOrg(owner.id, "עסק מהעתיד");
    // created_at is sent with the insert, a year ahead
    const lead = await insertLead(owner.id, org, { created_at: new Date(Date.now() + 365 * 86_400_000).toISOString() });
    const stored = await asAdmin(async (q) => (await q<{ c: Date }>("select created_at as c from public.leads where id = $1", [lead])).rows[0].c);
    expect(stored.getTime()).toBeGreaterThan(Date.now() + 300 * 86_400_000);

    await logEntry(owner.id, org, lead);
    const row = await activation(org);
    expect(row).toBeDefined();
    expect(row!.lead_created_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row!.activated_at.getTime()).toBeLessThanOrEqual(Date.now());
    expect(row!.activated_at.getTime()).toBeGreaterThanOrEqual(row!.lead_created_at.getTime());

    // the one-time fill reads it the same way
    const backfillOrg = await createOrg(owner.id, "עסק מהעתיד ותיק");
    const oldLeadId = await insertLead(owner.id, backfillOrg, { created_at: new Date(Date.now() + 365 * 86_400_000).toISOString() });
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("insert into public.activities (organization_id, type, body, lead_id, occurred_at, created_by) values ($1, 'call', 'x', $2, now(), $3)", [backfillOrg, oldLeadId, owner.id]);
    });
    expect(await activation(backfillOrg)).toBeUndefined();
    await rerun();
    const filled = await activation(backfillOrg);
    expect(filled).toBeDefined();
    expect(filled!.lead_created_at.getTime()).toBeLessThanOrEqual(Date.now());

    // the median of the metrics never goes below zero
    const staff = await createUser("act-staff-future");
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'readonly')", [staff.id]));
    const metrics = await asMfaUser(staff.id, async (q) => (await q<{ r: { activation: { median_hours: number } } }>("select public.platform_metrics() as r")).rows[0].r);
    expect(metrics.activation.median_hours).toBeGreaterThanOrEqual(0);
  });

  it("a private note counts only once it is made public", async () => {
    const org = await createOrg(owner.id, "עסק עם הערה פרטית");
    const lead = await insertLead(owner.id, org);
    const note = await logEntry(owner.id, org, lead, { type: "note", isPrivate: true });
    expect(await activation(org)).toBeUndefined();
    await asUser(owner.id, (q) => q("update public.activities set is_private = false where id = $1", [note]));
    expect(await activation(org)).toBeDefined();
  });

  it("clients cannot read or write the metric", async () => {
    const org = await createOrg(owner.id, "עסק סקרן");
    await insertLead(owner.id, org);
    for (const sql of [
      "select * from app.org_activation",
      `insert into app.org_activation (organization_id, activated_at, lead_created_at) values ('${org}', now(), now())`,
      "update app.org_activation set activated_at = now()",
      "delete from app.org_activation",
    ]) {
      expect((await pgError(asMfaUser(owner.id, (q) => q(sql)))).code).toBe("42501");
    }
    expect((await pgError(asMfaUser(owner.id, (q) => q("select app.mark_org_activation()")))).code).toBe("42501");
  });

  it("the platform panel shows it: org card, org list and metrics", async () => {
    const org = await createOrg(owner.id, "עסק בפאנל");
    const quiet = await createOrg(owner.id, "עסק שקט");
    const lead = await insertLead(owner.id, org);
    await logEntry(owner.id, org, lead);

    const staff = await createUser("act-staff");
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'readonly')", [staff.id]));
    const call = <T>(sql: string, params: unknown[] = []) =>
      asMfaUser(staff.id, async (q) => (await q<{ r: T }>(sql, params)).rows[0].r);

    const card = await call<{ activation: { activated_at: string; lead_created_at: string } | null }>("select public.platform_org($1) as r", [org]);
    expect(card.activation?.activated_at).toBeTruthy();
    expect((await call<{ activation: unknown }>("select public.platform_org($1) as r", [quiet])).activation).toBeNull();

    const list = await call<{ rows: Array<{ id: string; activated_at: string | null }> }>("select public.platform_list_orgs(null, null, null, 200, 0) as r");
    expect(list.rows.find((r) => r.id === org)?.activated_at).toBeTruthy();
    expect(list.rows.find((r) => r.id === quiet)?.activated_at).toBeNull();

    const metrics = await call<{ activation: { activated: number; median_hours: number | null } }>("select public.platform_metrics() as r");
    expect(metrics.activation.activated).toBeGreaterThanOrEqual(1);
    expect(typeof metrics.activation.median_hours).toBe("number");

    // a customer, even an owner with MFA, gets nothing
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_org($1)", [org])))).code).toBe("42501");
  });

  it("the one-time fill finds organizations that got there before the trigger, and is safe to run twice", async () => {
    const org = await createOrg(owner.id, "עסק ותיק");
    const slow = await createOrg(owner.id, "עסק ותיק ואיטי");
    const lead = await oldLead(owner.id, org, 72);
    const slowLead = await oldLead(owner.id, slow, 72);
    // entries as they were logged before the trigger existed
    const logOld = (o: string, l: string, hoursAgo: number) =>
      asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q(
          "insert into public.activities (organization_id, type, body, lead_id, occurred_at, created_by) values ($1, 'call', 'x', $2, now() - make_interval(hours => $3), $4)",
          [o, l, hoursAgo, owner.id],
        );
      });
    await logOld(org, lead, 70); // 2 hours after the lead
    await logOld(org, lead, 60); // later, also inside 24 hours: not the first
    await logOld(slow, slowLead, 10); // 62 hours after the lead
    expect(await activation(org)).toBeUndefined();

    await rerun();
    const row = await activation(org);
    expect(row).toBeDefined();
    expect(row!.activated_at.getTime() - row!.lead_created_at.getTime()).toBeGreaterThan(1.9 * 3_600_000);
    expect(row!.activated_at.getTime() - row!.lead_created_at.getTime()).toBeLessThan(2.1 * 3_600_000);
    expect(await activation(slow)).toBeUndefined();

    await rerun();
    expect(await activation(org)).toEqual(row);
  });
});

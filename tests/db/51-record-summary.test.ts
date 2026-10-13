import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type Summary = {
  deals: { status: string; currency: string; count: number; sum: number }[];
  last_touch: { type: string; occurred_at: string } | null;
  next_task: { id: string; title: string; task_type: string; due_at: string | null } | null;
  open_tasks: number;
};

/**
 * REC-10: public.record_summary() is SECURITY INVOKER. These tests check the
 * numbers on a small known data set (a company counts its own links and its
 * contacts', each row once), and that RLS decides what is counted.
 */
describe("record_summary: the contact / company card summary", () => {
  let owner: { id: string }, member: { id: string }, outsider: { id: string };
  let org: string;
  let company: string, contactA: string, contactB: string, loner: string;
  let companyTask: string, undatedTask: string;

  const summary = (userId: string, type: string, id: string): Promise<Summary> =>
    asUser(userId, async (q) => (await q<{ s: Summary }>("select public.record_summary($1, $2, $3) as s", [org, type, id])).rows[0].s);

  beforeAll(async () => {
    owner = await createUser("sum-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "sum-member");
    outsider = await createUser("sum-outsider");
    await createOrg(outsider.id, "עסק אחר");
    const { pipelineId, stages } = await defaultPipeline(org);
    const stage = (kind: string) => stages.find((s) => s.kind === kind)!.id;
    let trashed = "";

    await asUser(owner.id, async (q) => {
      const one = async (sql: string, params: unknown[]) => (await q<{ id: string }>(sql, params)).rows[0].id;
      company = await one("insert into public.companies (organization_id, name) values ($1, 'חברת סיכום') returning id", [org]);
      const contact = (name: string, companyId: string | null) =>
        one("insert into public.contacts (organization_id, first_name, company_id) values ($1, $2, $3) returning id", [org, name, companyId]);
      contactA = await contact("אבי", company);
      contactB = await contact("בתיה", company);
      loner = await contact("יחיד", null);

      const deal = (name: string, amount: number, kind: string, contactId: string | null, companyId: string | null, currency = "ILS") =>
        one(
          `insert into public.deals (organization_id, name, amount_agorot, currency, pipeline_id, stage_id, contact_id, company_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [org, name, amount, currency, pipelineId, stage(kind), contactId, companyId],
        );
      await deal("זכייה", 100000, "won", contactA, null);
      // linked both to contact A and to the company: counted once for the company
      await deal("פתוחה כפולה", 20000, "open", contactA, company);
      await deal("פתוחה של החברה", 30000, "open", null, company);
      // TAX-06: shekels only for now (deals_currency_ils); amounts in another currency: last test
      await deal("של בתיה", 5000, "open", contactB, null);
      await deal("אבודה", 99999, "lost", contactA, null);
      await deal("של אחר", 77777, "won", loner, null);
      trashed = await deal("בסל", 88888, "open", contactA, null);

      const activity = (type: string, at: string, contactId: string | null, companyId: string | null) =>
        q("insert into public.activities (organization_id, type, body, occurred_at, contact_id, company_id) values ($1, $2, 'x', $3, $4, $5)", [
          org,
          type,
          at,
          contactId,
          companyId,
        ]);
      const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
      await activity("note", daysAgo(3), null, company);
      await activity("call", daysAgo(1), contactA, null);
      // a meeting that has not happened yet: not a touch (a system event, below, is not one either)
      await activity("meeting", daysAgo(-1), contactA, null);

      const task = (title: string, due: string | null, contactId: string | null, companyId: string | null, status = "open") =>
        one(
          "insert into public.tasks (organization_id, title, due_at, contact_id, company_id, status) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, title, due, contactId, companyId, status],
        );
      await task("של בתיה", daysAgo(-2), contactB, null);
      companyTask = await task("של החברה", daysAgo(-1), null, company);
      await task("שבוצעה", daysAgo(5), contactA, null, "done");
      undatedTask = await task("בלי תאריך", null, contactA, null);
    });
    // in the recycle bin: not counted
    await asAdmin((q) => q("update public.deals set deleted_at = now() where id = $1", [trashed]));
    // a system event, written by the server (a client may log only the six contact types, RVW-11)
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, occurred_at, contact_id, created_by) values ($1, 'stage_change', 'x', now(), $2, $3)", [org, contactA, owner.id]),
    );
  });

  it("a contact: its own won and open deals, last real touch, next open task", async () => {
    const s = await summary(owner.id, "contact", contactA);
    expect(s.deals).toEqual([
      { status: "open", currency: "ILS", count: 1, sum: 20000 },
      { status: "won", currency: "ILS", count: 1, sum: 100000 },
    ]);
    expect(s.last_touch?.type).toBe("call");
    expect(s.next_task?.id).toBe(undatedTask);
    expect(s.open_tasks).toBe(1);
  });

  it("a company: its own links plus its contacts', each deal once", async () => {
    const s = await summary(owner.id, "company", company);
    expect(s.deals).toEqual([
      { status: "open", currency: "ILS", count: 3, sum: 55000 },
      { status: "won", currency: "ILS", count: 1, sum: 100000 },
    ]);
    expect(s.last_touch?.type).toBe("call");
    // the nearest due date wins; an undated task comes last
    expect(s.next_task?.id).toBe(companyTask);
    expect(s.next_task?.title).toBe("של החברה");
    expect(s.open_tasks).toBe(3);
  });

  it("a contact that moved out of the company no longer counts for it", async () => {
    await asUser(owner.id, (q) => q("update public.contacts set company_id = null where id = $1", [contactB]));
    try {
      const s = await summary(owner.id, "company", company);
      expect(s.deals.find((d) => d.status === "open")).toEqual({ status: "open", currency: "ILS", count: 2, sum: 50000 });
      expect(s.open_tasks).toBe(2);
    } finally {
      await asUser(owner.id, (q) => q("update public.contacts set company_id = $1 where id = $2", [company, contactB]));
    }
  });

  it("currencies are summed apart (ready for wave 6; the ILS-only check is lifted inside a rolled-back transaction)", async () => {
    let result: Summary | null = null;
    await asAdmin(async (q) => {
      const { pipelineId, stages } = await defaultPipeline(org);
      await q("alter table public.deals drop constraint deals_currency_ils");
      await q(
        `insert into public.deals (organization_id, name, amount_agorot, currency, pipeline_id, stage_id, contact_id)
         values ($1, 'בדולר', 7000, 'USD', $2, $3, $4)`,
        [org, pipelineId, stages.find((st) => st.kind === "open")!.id, contactB],
      );
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated" })]);
      await q("set local role authenticated");
      result = (await q<{ s: Summary }>("select public.record_summary($1, 'company', $2) as s", [org, company])).rows[0].s;
      throw new Error("rollback");
    }).catch((error: Error) => {
      if (error.message !== "rollback") throw error;
    });
    expect(result!.deals).toEqual([
      { status: "open", currency: "ILS", count: 3, sum: 55000 },
      { status: "open", currency: "USD", count: 1, sum: 7000 },
      { status: "won", currency: "ILS", count: 1, sum: 100000 },
    ]);
    // the check is back
    const back = await pgError(asAdmin((q) => q("update public.deals set currency = 'USD' where organization_id = $1", [org])));
    expect(back.code).toBe("23514");
  });

  it("RLS decides: with 'own' visibility a member counts only their own deals", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const { pipelineId, stages } = await defaultPipeline(org);
      await asUser(member.id, (q) =>
        q(
          `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, contact_id, owner_id)
           values ($1, 'של החבר', 4000, $2, $3, $4, $5)`,
          [org, pipelineId, stages.find((s) => s.kind === "open")!.id, contactA, member.id],
        ),
      );
      const s = await summary(member.id, "contact", contactA);
      expect(s.deals).toEqual([{ status: "open", currency: "ILS", count: 1, sum: 4000 }]);
      expect(s.next_task).toBeNull();
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("someone from another organization gets nothing", async () => {
    const s = await summary(outsider.id, "company", company);
    expect(s).toEqual({ deals: [], last_touch: null, next_task: null, open_tasks: 0, next_meeting: null });
  });

  it("refuses an unknown record type", async () => {
    const error = await pgError(summary(owner.id, "lead", contactA));
    expect(error.code).toBe("22023");
  });

  it("runs with the caller's rights (security invoker)", async () => {
    const definer = await asAdmin(
      async (q) => (await q<{ d: boolean }>("select prosecdef as d from pg_proc where oid = 'public.record_summary(uuid, text, uuid)'::regprocedure")).rows[0].d,
    );
    expect(definer).toBe(false);
  });
});

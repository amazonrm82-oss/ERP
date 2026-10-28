import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPORTS } from "../../src/features/reports/definitions";
import { parseReportData } from "../../src/features/reports/schemas";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Aging = { current: number; d1_30: number; d31_60: number; d61_90: number; d91_plus: number };

/**
 * BAL-03: debt aging. Age = whole days since the due date in the business's zone; overdue from the day after it (BAL-02),
 * so 0-30 holds 1..30 days late and what is not overdue (due today or later, or no due date) is `current`. The buckets add
 * up to the open debt. Per customer on the card (BAL-01's rights and partial rule), and for the business in
 * public.report_debt_aging (invoker; partial when any document or payment of the business is hidden).
 */
describe("debt aging (BAL-03)", () => {
  let owner: U, manager: U, member: U, keyHolder: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, granular_permissions: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const company = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const contact = (name: string, companyId: string | null = null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, ownerId])).id,
    );
  const deal = (name: string, contactId: string | null, companyId: string | null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, name, pipelineId, stageId, contactId, companyId, ownerId],
        )
      ).id,
    );
  const doc = (amount: number, due: string | null, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, $3, 'tax_invoice', $4, $5, $6, $7) returning id",
          [org, on.deal ?? null, on.contact ?? null, `AG-${++n}`, day(-200), amount, due],
        )
      ).id,
    );
  const aging = (u: U, where: { contact?: string | null; company?: string | null }) =>
    run(u, async (q) => (await one<{ s: { allowed: boolean; partial?: boolean; open_debt?: number; aging?: Aging } }>(q, "select public.customer_debt_summary($1, $2, $3) as s", [org, where.contact ?? null, where.company ?? null])).s);
  const report = (u: U, ownerId: string | null = null) =>
    run(u, async (q) => parseReportData("report_debt_aging", (await one<{ r: unknown }>(q, "select public.report_debt_aging($1, $2) as r", [org, ownerId])).r));
  const nums = (a: Aging) => [a.current, a.d1_30, a.d31_60, a.d61_90, a.d91_plus].map(Number);

  beforeAll(async () => {
    owner = await createUser("ag-owner");
    org = await createOrg(owner.id, "עסק הגיול");
    manager = await addMember(org, owner.id, "manager", "ag-manager");
    member = await addMember(org, owner.id, "member", "ag-member");
    keyHolder = await addMember(org, owner.id, "member", "ag-key");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, keyHolder.id]));
  });

  it("buckets by whole days late, the edges included, and adds up to the open debt", async () => {
    const a = await contact("אורי");
    // current: due in 5 days, due today
    await doc(100, day(5), { contact: a });
    await doc(200, day(0), { contact: a });
    // 1..30
    await doc(1000, day(-1), { contact: a });
    await doc(2000, day(-30), { contact: a });
    // 31..60
    await doc(10000, day(-31), { contact: a });
    await doc(20000, day(-60), { contact: a });
    // 61..90
    await doc(100000, day(-61), { contact: a });
    await doc(200000, day(-90), { contact: a });
    // over 90
    await doc(1000000, day(-91), { contact: a });
    // no due date: not overdue
    await run(owner, (q) => q("select public.opening_balance_set($1, $2, null, 7, $3)", [org, a, day(-300)]));
    const s = await aging(owner, { contact: a });
    expect(nums(s.aging!)).toEqual([307, 3000, 30000, 300000, 1000000]);
    expect(Number(s.open_debt)).toBe(1333307);
  });

  it("the report: customers by PAY-02's customer, totals over all, most overdue first, an owner filter", async () => {
    const co = await company("חברת הגיול");
    const inCo = await contact("בתיה", co);
    const alone = await contact("גיל", null, keyHolder.id);
    const lonelyDeal = await deal("עסקה בודדת", null, null, keyHolder.id);
    const coDeal = await deal("עסקת החברה", null, co);
    await doc(5000, day(-10), { contact: inCo });
    await doc(7000, day(-100), { deal: coDeal });
    await doc(3000, day(-45), { contact: alone });
    await doc(900, day(3), { deal: lonelyDeal });

    const r = await report(owner);
    if (!r.allowed || r.partial) throw new Error("expected the full report");
    const byName = new Map(r.customers.map((c) => [c.name, c]));
    expect(byName.get("חברת הגיול")).toMatchObject({ kind: "company", id: co, d1_30: 5000, d91_plus: 7000, total: 12000, overdue: 12000, documents: 2 });
    expect(byName.get("גיל")).toMatchObject({ kind: "contact", id: alone, d31_60: 3000, total: 3000 });
    expect(byName.get("עסקה בודדת")).toMatchObject({ kind: "deal", id: lonelyDeal, current: 900, overdue: 0, oldest_due_date: null });
    // the company's row equals its card
    const card = await aging(owner, { company: co });
    const row = byName.get("חברת הגיול")!;
    expect(nums(card.aging!)).toEqual([row.current, row.d1_30, row.d31_60, row.d61_90, row.d91_plus]);
    // totals over every customer; buckets add up; most overdue first
    const sum = (k: keyof Aging) => r.customers.reduce((s, c) => s + c[k], 0);
    expect([r.totals.current, r.totals.d1_30, r.totals.d31_60, r.totals.d61_90, r.totals.d91_plus]).toEqual([sum("current"), sum("d1_30"), sum("d31_60"), sum("d61_90"), sum("d91_plus")]);
    expect(r.totals.total).toBe(r.totals.current + r.totals.d1_30 + r.totals.d31_60 + r.totals.d61_90 + r.totals.d91_plus);
    expect(r.totals.customers).toBe(r.customers.length);
    const overdue = r.customers.map((c) => c.overdue);
    expect(overdue).toEqual([...overdue].sort((x, y) => y - x));

    // the owner filter: the document's deal's owner, else its contact's
    const mine = await report(owner, keyHolder.id);
    if (!mine.allowed || mine.partial) throw new Error("expected the full report");
    expect(mine.customers.map((c) => c.name).sort()).toEqual(["גיל", "עסקה בודדת"]);
  });

  it("rights: no figure for someone hidden from a row, nothing without the rights or keys; the export key follows", async () => {
    expect(await report(member)).toEqual({ allowed: false });
    expect((await pgError(run(member, (q) => q("select public.log_export($1, 'report', 'debt_aging', 1, 'csv')", [org]))))).toMatchObject({ code: "42501" });
    // the key holder reads everything while visibility is the business's
    expect((await report(keyHolder)).allowed).toBe(true);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await report(keyHolder)).toEqual({ allowed: true, partial: true });
      expect(await report(manager)).toEqual({ allowed: true, partial: true });
      expect(await report(owner)).toMatchObject({ allowed: true, partial: false });
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, balances: false })]));
    try {
      expect(await report(owner)).toEqual({ allowed: false });
      expect((await pgError(run(owner, (q) => q("select public.log_export($1, 'report', 'debt_aging', 1, 'csv')", [org]))))).toMatchObject({ hint: "feature:balances" });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
    await run(owner, (q) => q("select public.log_export($1, 'report', 'debt_aging', 1, 'csv')", [org]));
    expect(REPORTS.find((x) => x.key === "debt_aging")?.balances).toBe(true);
  });

  it("another business sees nothing", async () => {
    const stranger = await createUser("ag-stranger");
    await createOrg(stranger.id, "עסק זר");
    expect(await run(stranger, async (q) => (await one<{ r: unknown }>(q, "select public.report_debt_aging($1) as r", [org])).r)).toEqual({ allowed: false });
    expect(await run(stranger, async (q) => (await one<{ v: unknown }>(q, "select app.business_money_rows($1) as v", [org])).v)).toBeNull();
  });

  it("is security invoker and closed to anon; the count is a definer with no anon access", async () => {
    const fns = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; definer: boolean; anon: boolean; authed: boolean }>(
            `select n.nspname || '.' || p.proname as name, p.prosecdef as definer,
                    has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authed
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname in ('report_debt_aging', 'customer_debt_summary'))
                 or (n.nspname = 'app' and p.proname = 'business_money_rows')
              order by 1`,
          )
        ).rows,
    );
    expect(fns).toEqual([
      { name: "app.business_money_rows", definer: true, anon: false, authed: true },
      { name: "public.customer_debt_summary", definer: false, anon: false, authed: true },
      { name: "public.report_debt_aging", definer: false, anon: false, authed: true },
    ]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Report = {
  currency: string;
  totals: Record<string, number>;
  by_month: Array<{ month: string; deals: number; new_mrr: number; monthly_deals: number; monthly_mrr: number; yearly_deals: number; yearly_mrr: number }>;
  by_owner: Array<{ owner_id: string | null; deals: number; new_mrr: number }>;
};

/**
 * RPT-01, the recurring revenue report (owner, 18 October 2026: every plan; new recurring revenue by close month).
 * public.report_recurring_revenue(org, from date, to date, pipeline, owner) is security invoker: report_revenue's won-deal
 * rule (won, not in the bin, closed in the period in the business's zone), recurring deals only (billing_kind monthly |
 * yearly); a month's amount is the monthly amount, or the yearly amount / 12 rounded half up per deal.
 */
describe("recurring revenue report (RPT-01)", () => {
  let owner: U, m1: U, m2: U, outsider: U;
  let org: string, otherOrg: string;
  let pipeline1: string, pipeline2: string;
  const stage: Record<string, Record<string, string>> = {};
  const deal: Record<string, string> = {};

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const report = (u: U, from = "2026-09-01", to = "2026-10-31", pipeline: string | null = null, ownerId: string | null = null, orgId = org) =>
    asUser(u.id, async (q) =>
      (await one<{ r: Report }>(q, "select public.report_recurring_revenue($1, $2::date, $3::date, $4, $5) as r", [orgId, from, to, pipeline, ownerId])).r,
    );

  // a deal made as the server, closed at a given instant (local Jerusalem time, as typed)
  const addDeal = (
    key: string,
    row: { pipeline?: string; kind: "won" | "open" | "lost"; owner: string; billing: "monthly" | "yearly" | null; amount?: number; closedLocal?: string },
  ) =>
    asAdmin(async (q) => {
      const p = row.pipeline ?? pipeline1;
      const id = (
        await one<{ id: string }>(
          q,
          `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, billing_kind, recurring_amount_agorot,
                                     recurring_start_date, closed_at)
           values ($1, $2, 0, $3, $4, $5, $6, $7, case when $6::text is null then null else date '2026-09-01' end,
                   case when $8::text is null then null else ($8::timestamp at time zone 'Asia/Jerusalem') end)
           returning id`,
          [org, key, p, stage[p][row.kind], row.owner, row.billing, row.billing ? (row.amount ?? 0) : null, row.closedLocal ?? null],
        )
      ).id;
      deal[key] = id;
      return id;
    });

  beforeAll(async () => {
    owner = await createUser("mrr-owner");
    outsider = await createUser("mrr-outsider");
    org = await createOrg(owner.id, "עסק הכנסה חוזרת");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    m1 = await addMember(org, owner.id, "member", "mrr-m1");
    m2 = await addMember(org, owner.id, "member", "mrr-m2");

    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]);
      pipeline1 = (await one<{ id: string }>(q, "select id from public.pipelines where organization_id = $1 and is_default", [org])).id;
      pipeline2 = (await one<{ id: string }>(q, "insert into public.pipelines (organization_id, name) values ($1, 'שני') returning id", [org])).id;
      for (const p of [pipeline1, pipeline2]) {
        const stages = (await q<{ id: string; kind: string }>("select id, kind from public.stages where pipeline_id = $1 order by position", [p])).rows;
        if (stages.length === 0) {
          for (const [i, kind] of ["open", "won", "lost"].entries()) {
            await q("insert into public.stages (organization_id, pipeline_id, name, kind, position) values ($1, $2, $3, $4, $5)", [org, p, kind, kind, i]);
          }
        }
        const rows = (await q<{ id: string; kind: string }>("select id, kind from public.stages where pipeline_id = $1 order by position", [p])).rows;
        stage[p] = {};
        for (const r of rows) stage[p][r.kind] ??= r.id;
      }
    });

    // September (Jerusalem): a monthly deal and a yearly one closed half an hour before October in Jerusalem
    await addDeal("A", { kind: "won", owner: m1.id, billing: "monthly", amount: 9999, closedLocal: "2026-09-15 12:00" });
    await addDeal("B", { kind: "won", owner: owner.id, billing: "yearly", amount: 100006, closedLocal: "2026-09-30 23:30" });
    // October: a yearly deal closed half an hour into October in Jerusalem (still September in UTC), in the second pipeline,
    // whose twelfth is exactly half an agora; and a monthly deal with no recurring amount yet
    await addDeal("C", { pipeline: pipeline2, kind: "won", owner: m2.id, billing: "yearly", amount: 100002, closedLocal: "2026-10-01 00:30" });
    await addDeal("D", { kind: "won", owner: m1.id, billing: "monthly", amount: 0, closedLocal: "2026-10-05 10:00" });
    // August, one minute before September in Jerusalem
    await addDeal("I", { kind: "won", owner: owner.id, billing: "monthly", amount: 7000, closedLocal: "2026-08-31 23:59" });
    // never counted: one-time, in the bin, open, lost
    await addDeal("E", { kind: "won", owner: owner.id, billing: null, closedLocal: "2026-09-10 10:00" });
    await addDeal("F", { kind: "won", owner: owner.id, billing: "monthly", amount: 50000, closedLocal: "2026-09-10 10:00" });
    await addDeal("G", { kind: "open", owner: owner.id, billing: "monthly", amount: 60000 });
    await addDeal("H", { kind: "lost", owner: owner.id, billing: "monthly", amount: 70000, closedLocal: "2026-09-10 10:00" });
    await asAdmin(async (q) => {
      await q("update public.deals set deleted_at = now() where id = $1", [deal.F]);
      // one deal priced with VAT, one before it (one mode per deal, from its lines); C and D have no lines
      await q("insert into public.org_document_settings (organization_id, prices_include_vat) values ($1, true) on conflict (organization_id) do update set prices_include_vat = true", [org]);
      await q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot, billing) values ($1, $2, 'שירות', 1, 9999, 'monthly')", [org, deal.A]);
      await q("update public.org_document_settings set prices_include_vat = false where organization_id = $1", [org]);
      await q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot, billing) values ($1, $2, 'מנוי', 1, 100006, 'yearly')", [org, deal.B]);
    });
  });

  it("the deals are where the test needs them", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ name: string; status: string; billing_kind: string | null; recurring_amount_agorot: number | null }>(
          "select name, status, billing_kind, recurring_amount_agorot from public.deals where organization_id = $1 order by name",
          [org],
        )
      ).rows,
    );
    const by = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect([by.A.status, by.B.status, by.C.status, by.D.status, by.H.status]).toEqual(["won", "won", "won", "won", "lost"]);
    expect([by.A.recurring_amount_agorot, by.B.recurring_amount_agorot, by.C.recurring_amount_agorot].map(Number)).toEqual([9999, 100006, 100002]);
  });

  it("counts new recurring revenue by close month in the business's zone, a yearly deal as its twelfth rounded half up", async () => {
    const r = await report(owner);
    expect(r.currency).toBe("ILS");
    expect(r.by_month).toEqual([
      // A 9,999 + B 100,006 / 12 = 8,333.83 -> 8,334
      { month: "2026-09-01", deals: 2, new_mrr: 18333, monthly_deals: 1, monthly_mrr: 9999, yearly_deals: 1, yearly_mrr: 8334 },
      // C 100,002 / 12 = 8,333.5 -> 8,334 (half up), D 0
      { month: "2026-10-01", deals: 2, new_mrr: 8334, monthly_deals: 1, monthly_mrr: 0, yearly_deals: 1, yearly_mrr: 8334 },
    ]);
    expect(r.totals).toEqual({
      deals: 4,
      new_mrr: 26667,
      monthly_deals: 2,
      monthly_mrr: 9999,
      yearly_deals: 2,
      yearly_mrr: 16668,
      yearly_amount: 200008,
      deals_without_amount: 1,
      deals_with_vat: 1,
      deals_without_vat: 1,
    });
    expect(r.by_owner).toEqual([
      { owner_id: m1.id, deals: 2, new_mrr: 9999 },
      { owner_id: m2.id, deals: 1, new_mrr: 8334 },
      { owner_id: owner.id, deals: 1, new_mrr: 8334 },
    ].sort((a, b) => b.new_mrr - a.new_mrr || b.deals - a.deals || (a.owner_id < b.owner_id ? -1 : 1)));
  });

  it("lists every month of the period, zeros included, and keeps the edge of each month in the business's zone", async () => {
    const r = await report(owner, "2026-07-01", "2026-10-31");
    expect(r.by_month.map((m) => [m.month, m.deals, m.new_mrr])).toEqual([
      ["2026-07-01", 0, 0],
      ["2026-08-01", 1, 7000],
      ["2026-09-01", 2, 18333],
      ["2026-10-01", 2, 8334],
    ]);
    // the last day is inclusive: B (23:30 on 30 September) is in, C (00:30 on 1 October) is out
    const sep = await report(owner, "2026-09-30", "2026-09-30");
    expect(sep.totals.deals).toBe(1);
    expect(sep.totals.new_mrr).toBe(8334);
    expect(sep.by_month.map((m) => m.month)).toEqual(["2026-09-01"]);
    const oct1 = await report(owner, "2026-10-01", "2026-10-01");
    expect(oct1.totals.deals).toBe(1);
    expect(oct1.by_owner).toEqual([{ owner_id: m2.id, deals: 1, new_mrr: 8334 }]);
  });

  it("filters by pipeline and by owner as report_revenue does", async () => {
    const p2 = await report(owner, "2026-09-01", "2026-10-31", pipeline2);
    expect(p2.totals.deals).toBe(1);
    expect(p2.totals.new_mrr).toBe(8334);
    const mine = await report(owner, "2026-09-01", "2026-10-31", null, m1.id);
    expect(mine.totals).toMatchObject({ deals: 2, new_mrr: 9999, deals_without_amount: 1, deals_with_vat: 1, deals_without_vat: 0 });
    expect(mine.by_owner).toEqual([{ owner_id: m1.id, deals: 2, new_mrr: 9999 }]);
  });

  it("RLS decides: a member who sees only their own deals counts only those; another business sees nothing", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const r = await report(m1);
      expect(r.totals).toMatchObject({ deals: 2, new_mrr: 9999, yearly_deals: 0 });
      expect(r.by_owner.map((o) => o.owner_id)).toEqual([m1.id]);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    const other = await report(outsider);
    expect(other.totals.deals).toBe(0);
    expect(other.by_owner).toEqual([]);
    expect(other.by_month.map((m) => m.new_mrr)).toEqual([0, 0]);
    // the outsider's own business has none of these deals either
    const own = await report(outsider, "2026-09-01", "2026-10-31", null, null, otherOrg);
    expect(own.totals.deals).toBe(0);
  });

  it("refuses a missing or reversed period, or one longer than 3,660 days", async () => {
    expect((await pgError(report(owner, "2026-10-31", "2026-09-01"))).code).toBe("22023");
    expect((await pgError(report(owner, "2010-01-01", "2026-10-31"))).code).toBe("22023");
    expect((await pgError(asUser(owner.id, (q) => q("select public.report_recurring_revenue($1, null, '2026-10-31'::date)", [org])))).code).toBe("22023");
  });

  it("is invoker, for signed-in users only, and the export accepts its key", async () => {
    const fn = await asAdmin(async (q) =>
      one<{ definer: boolean; anon: boolean; auth: boolean }>(
        q,
        `select p.prosecdef as definer,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p where p.oid = 'public.report_recurring_revenue(uuid, date, date, uuid, uuid)'::regprocedure`,
      ),
    );
    expect(fn).toEqual({ definer: false, anon: false, auth: true });
    expect((await pgError(asAnon((q) => q("select public.report_recurring_revenue($1, '2026-09-01'::date, '2026-10-31'::date)", [org])))).code).toBe("42501");

    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'recurring', 3, 'xlsx')", [org]));
    const logged = await asAdmin(async (q) =>
      (await q<{ report: string }>("select changes->>'report' as report from public.audit_log where organization_id = $1 and action = 'export'", [org])).rows,
    );
    expect(logged.map((l) => l.report)).toContain("recurring");
    // a member without the export right is refused, as for every report
    expect((await pgError(asUser(m1.id, (q) => q("select public.log_export($1, 'report', 'recurring', 1, 'csv')", [org])))).code).toBe("42501");
  });
});

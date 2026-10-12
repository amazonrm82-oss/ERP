import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = Record<string, unknown>;

/**
 * The reports are SECURITY INVOKER functions: these tests check the numbers on
 * a small known data set, and that a member who may see only their own records
 * gets a report of their own records only.
 */
describe("reports", () => {
  let owner: U, member: U, outsider: U;
  let org: string;
  let sourceId: string;
  let wonDeal: string;
  let lostDeal: string;
  const from = () => new Date(Date.now() - 86_400_000).toISOString();
  const to = () => new Date(Date.now() + 86_400_000).toISOString();

  const report = async <T = unknown>(userId: string, sql: string, params: unknown[]): Promise<T> =>
    asUser(userId, async (q) => (await q<{ r: T }>(`select ${sql} as r`, params)).rows[0].r);

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    await createOrg(outsider.id, "עסק אחר");
    member = await addMember(org, owner.id, "member", "rep");

    sourceId = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 order by name limit 1", [org])).rows[0].id,
    );

    // owner: two leads from the source in the "winter" campaign; one becomes a won deal
    const lead1 = await insertLead(owner.id, org, { source_id: sourceId, campaign: "חורף" });
    await insertLead(owner.id, org, { source_id: sourceId, campaign: "חורף" });
    // member: one lead of their own, contacted by a logged call
    const lead3 = await insertLead(member.id, org, { owner_id: member.id });
    await asUser(member.id, (q) =>
      q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה ראשונה', $2)", [org, lead3]),
    );

    wonDeal = await asUser(owner.id, async (q) =>
      (await q<{ r: { deal_id: string } }>("select public.convert_lead($1, true, null, 100000) as r", [lead1])).rows[0].r.deal_id,
    );
    await asUser(owner.id, (q) =>
      q(
        `update public.deals d set stage_id = s.id from public.stages s
          where d.id = $1 and s.organization_id = d.organization_id and s.pipeline_id = d.pipeline_id and s.kind = 'won'`,
        [wonDeal],
      ),
    );

    // member: a deal moved one stage on, then lost over price
    lostDeal = await asUser(member.id, async (q) => {
      const pipeline = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const first = (
        await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [pipeline])
      ).rows[0].id;
      const id = (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id) values ($1, 'עסקה שאבדה', 50000, $2, $3, $4) returning id",
          [org, pipeline, first, member.id],
        )
      ).rows[0].id;
      await q(
        `update public.deals d set stage_id = s.id, lost_reason = 'מחיר' from public.stages s
          where d.id = $1 and s.pipeline_id = d.pipeline_id and s.kind = 'lost'`,
        [id],
      );
      return id;
    });

    // an open deal of the member's, with no task: a stuck deal
    await asUser(member.id, (q) =>
      q(
        `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, expected_close_date)
         select $1, 'עסקה פתוחה', 80000, p.id, s.id, $2, (now() + interval '20 days')::date
           from public.pipelines p join public.stages s on s.pipeline_id = p.id and s.kind = 'open'
          where p.organization_id = $1 and p.is_default order by s.position limit 1`,
        [org, member.id],
      ),
    );
  });

  it("leads by source counts leads, conversions and revenue per source and campaign", async () => {
    const rows = await report<Row[]>(owner.id, "public.report_leads_by_source($1, $2, $3)", [org, from(), to()]);
    const winter = rows.find((r) => r.source_id === sourceId && r.campaign === "חורף");
    expect(winter).toMatchObject({ leads: 2, converted: 1, won: 1, revenue: 100000 });
    expect(rows.reduce((sum, r) => sum + Number(r.leads), 0)).toBe(3);
  });

  it("funnel, response time and rep performance", async () => {
    const funnel = await report<{ leads: Row; stages: Row[]; deals: Row }>(owner.id, "public.report_funnel($1, $2, $3)", [org, from(), to()]);
    expect(funnel.leads).toMatchObject({ created: 3, contacted: 2, converted: 1, won: 1 });
    expect(funnel.deals).toMatchObject({ won: 1, lost: 1 });
    // every deal reached the first stage; the won deal counts as reaching all of them
    expect(funnel.stages[0].reached).toBe(3);
    expect(funnel.stages[funnel.stages.length - 1].reached).toBeGreaterThanOrEqual(1);

    const response = await report<Row[]>(owner.id, "public.report_response_time($1, $2, $3)", [org, from(), to()]);
    expect(response.find((r) => r.owner_id === member.id)).toMatchObject({ leads: 1, contacted: 1, within_hour: 1 });

    const reps = await report<Row[]>(owner.id, "public.report_rep_performance($1, $2, $3)", [org, from(), to()]);
    expect(reps.find((r) => r.owner_id === owner.id)).toMatchObject({ won: 1, won_amount: 100000 });
    expect(reps.find((r) => r.owner_id === member.id)).toMatchObject({ lost: 1, open_count: 1, open_amount: 80000 });
  });

  it("loss reasons, cycle length, revenue, forecast, stuck deals and the summary", async () => {
    const lost = await report<{ by_reason: Row[]; by_stage: Row[] }>(owner.id, "public.report_lost_reasons($1, $2, $3)", [org, from(), to()]);
    expect(lost.by_reason).toEqual([{ reason: "מחיר", deals: 1, amount: 50000 }]);
    expect(lost.by_stage[0].stage_id).toBeTruthy();

    const cycle = await report<Row>(owner.id, "public.report_cycle_length($1, $2, $3)", [org, from(), to()]);
    expect(cycle).toMatchObject({ won: 1, from_lead: 1 });

    const revenue = await report<{ by_month: Row[]; by_owner: Row[] }>(owner.id, "public.report_revenue($1, $2, $3)", [org, from(), to()]);
    expect(revenue.by_month.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(100000);

    const forecast = await report<Row[]>(owner.id, "public.report_forecast($1)", [org]);
    expect(forecast.reduce((sum, r) => sum + Number(r.amount), 0)).toBe(80000);

    const stuck = await report<Row[]>(owner.id, "public.report_stuck_deals($1)", [org]);
    expect(stuck.map((r) => r.name)).toContain("עסקה פתוחה");
    expect(stuck.find((r) => r.name === "עסקה פתוחה")).toMatchObject({ no_next_step: true });

    const summary = await report<Row>(owner.id, "public.report_summary($1, $2, $3, $4, $5)", [
      org,
      from(),
      to(),
      new Date(Date.now() - 30 * 86_400_000).toISOString(),
      from(),
    ]);
    expect(summary).toMatchObject({ leads: 3, won: 1, won_amount: 100000, lost: 1, open: 1, open_amount: 80000 });
  });

  it("a member limited to their own records gets a report of their own records only", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const rows = await report<Row[]>(member.id, "public.report_leads_by_source($1, $2, $3)", [org, from(), to()]);
      expect(rows.reduce((sum, r) => sum + Number(r.leads), 0)).toBe(1);
      const revenue = await report<{ by_month: Row[] }>(member.id, "public.report_revenue($1, $2, $3)", [org, from(), to()]);
      expect(revenue.by_month).toEqual([]);
      const summary = await report<Row>(member.id, "public.report_summary($1, $2, $3, $2, $3)", [org, from(), to()]);
      expect(summary).toMatchObject({ leads: 1, won: 0, lost: 1 });
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("another organization sees nothing, and anonymous callers are refused", async () => {
    const rows = await report<Row[]>(outsider.id, "public.report_leads_by_source($1, $2, $3)", [org, from(), to()]);
    expect(rows).toEqual([]);
    const summary = await report<Row>(outsider.id, "public.report_summary($1, $2, $3, $2, $3)", [org, from(), to()]);
    expect(summary).toMatchObject({ leads: 0, won: 0, open: 0, overdue_tasks: 0 });
    const err = await pgError(asAnon((q) => q("select public.report_summary($1, now(), now(), now(), now())", [org])));
    expect(err.code).toBe("42501");
  });

  it("a malformed stage_change does not break the reports", async () => {
    // a client can no longer write a stage_change (RVW-11); the server stands in for an old or broken row
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, deal_id, metadata) values ($1, 'stage_change', $2, $3)", [
        org,
        lostDeal,
        JSON.stringify({ from_stage_id: "not-a-uuid", to_stage_id: "x" }),
      ]),
    );
    const funnel = await report<{ leads: Row }>(owner.id, "public.report_funnel($1, $2, $3)", [org, from(), to()]);
    expect(funnel.leads.created).toBe(3);
    const cycle = await report<Row>(owner.id, "public.report_cycle_length($1, $2, $3)", [org, from(), to()]);
    expect(cycle.won).toBe(1);
  });
});

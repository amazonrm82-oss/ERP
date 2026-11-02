import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseReportData } from "../../src/features/reports/schemas";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = ReturnType<typeof parseReportData<"report_campaign_roi">>;
type Report = Extract<Answer, { allowed: true }>;

// SEG-03: public.campaign_costs (costs entered by hand) and public.report_campaign_roi (invoker): leads created in the
// period, deals won in the period by the first source (SEG-02's rule), the costs of the months whose first day is in the
// period, cost per lead and ROI per first source and per source and campaign. Review fixes and owner (65) ד: whoever may view
// costs (app.can_view_costs, the rule of product costs) reads them; a caller who may not, or who reads fewer records, is
// answered partial (BAL/COL's rule); a cost with no source has its own row and meets its
// campaign across every source; {allowed: false} without the plan key or for an outsider.
describe("campaign costs and ROI (SEG-03)", () => {
  let owner: U;
  let admin: U;
  let manager: U;
  let member: U;
  let granted: U;
  let viewer: U;
  let org: string;
  let facebook: string;
  let google: string;
  // the business's current month: [its first day, the first day of the next month)
  let monthStart: string;
  let range: [string, string];

  const cost = (fields: Record<string, unknown>, user: U = owner) =>
    asUser(user.id, async (q) => {
      const row = { organization_id: org, month: monthStart, amount_agorot: 10000, ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.campaign_costs (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0].id;
    });
  const answer = (user: U = owner, from = range[0], to = range[1]): Promise<Answer> =>
    asUser(user.id, async (q) =>
      parseReportData("report_campaign_roi", (await q<{ r: unknown }>("select public.report_campaign_roi($1, $2, $3) as r", [org, from, to])).rows[0].r),
    );
  const report = async (user: U = owner, from = range[0], to = range[1]): Promise<Report> => {
    const a = await answer(user, from, to);
    if (!a.allowed) throw new Error("not allowed");
    return a;
  };
  const winConverted = async (lead: string, amount: number) => {
    const deal = await asUser(owner.id, async (q) =>
      (await q<{ r: { deal_id: string } }>("select public.convert_lead($1, true, null, $2) as r", [lead, amount])).rows[0].r.deal_id,
    );
    await asUser(owner.id, (q) =>
      q("update public.deals d set stage_id = s.id from public.stages s where d.id = $1 and s.pipeline_id = d.pipeline_id and s.kind = 'won'", [deal]),
    );
    return deal;
  };

  beforeAll(async () => {
    owner = await createUser("roi-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "roi-admin");
    manager = await addMember(org, owner.id, "manager", "roi-manager");
    member = await addMember(org, owner.id, "member", "roi-member");
    granted = await addMember(org, owner.id, "member", "roi-granted");
    viewer = await addMember(org, owner.id, "viewer", "roi-viewer");
    // PRM-01: a member with the grant view_costs
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, granted.id, ["view_costs"]]));
    [facebook, google] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'פייסבוק') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'גוגל') returning id", [org])).rows[0].id,
    ]);
    const bounds = await asAdmin(async (q) =>
      (
        await q<{ month: string; from: string; to: string }>(
          `select to_char(m, 'YYYY-MM-DD') as month,
                  (m::timestamp at time zone 'Asia/Jerusalem')::text as "from",
                  (((m + interval '1 month')::date)::timestamp at time zone 'Asia/Jerusalem')::text as "to"
             from (select date_trunc('month', now() at time zone 'Asia/Jerusalem')::date as m) x`,
        )
      ).rows[0],
    );
    monthStart = bounds.month;
    range = [bounds.from, bounds.to];

    // facebook: 4 leads (two campaigns, one spelled differently), one converted and won for 300,000
    const won = await insertLead(owner.id, org, { source_id: facebook, campaign: "Winter", owner_id: owner.id });
    await insertLead(owner.id, org, { source_id: facebook, campaign: " winter ", owner_id: owner.id });
    await insertLead(owner.id, org, { source_id: facebook, campaign: "Summer", owner_id: owner.id });
    await insertLead(member.id, org, { source_id: facebook, owner_id: member.id });
    await winConverted(won, 300000);
    // google: 2 leads, no cost; one of them from the billboard campaign
    await insertLead(owner.id, org, { source_id: google, owner_id: owner.id });
    await insertLead(owner.id, org, { source_id: google, campaign: "billboard", owner_id: owner.id });

    // costs: 100,000 on facebook's winter campaign (two rows add up), 20,000 on facebook without a campaign, one last
    // month (outside the period), one campaign-only cost with no lead
    await cost({ source_id: facebook, campaign: "WINTER", amount_agorot: 60000 });
    await cost({ source_id: facebook, campaign: "winter", amount_agorot: 40000, note: "סוכנות" });
    await cost({ source_id: facebook, amount_agorot: 20000 });
    const lastMonth = await asAdmin(async (q) => (await q<{ m: string }>("select to_char(($1::date - interval '1 month')::date, 'YYYY-MM-DD') as m", [monthStart])).rows[0].m);
    await cost({ source_id: facebook, campaign: "Winter", month: lastMonth, amount_agorot: 999999 });
    await cost({ campaign: "Billboard", amount_agorot: 5000 });
  });

  it("counts leads, won revenue and costs per first source, with cost per lead and ROI", async () => {
    const r = await report();
    expect(r.partial).toBe(false);
    const fb = r.by_source.find((s) => s.source_id === facebook)!;
    expect(fb).toMatchObject({ kind: "source", source_name: "פייסבוק", leads: 4, deals: 1, revenue: 300000, cost: 120000, cost_per_lead: 30000, roi: 1.5 });
    const gg = r.by_source.find((s) => s.source_id === google)!;
    expect(gg).toMatchObject({ leads: 2, deals: 0, revenue: 0, cost: 0, cost_per_lead: null, roi: null });
    expect(r.totals).toMatchObject({ leads: 6, deals: 1, revenue: 300000, cost: 125000, cost_entries: 4, cost_per_lead: 20833, roi: 1.4 });
    // costs first; an admin sees the same
    expect(r.by_source[0].source_id).toBe(facebook);
    expect((await report(admin)).totals).toEqual(r.totals);
  });

  // review 3: a cost with no source never mixes with unsourced leads and revenue
  it("costs with no source have their own row, last, with no cost per lead or ROI", async () => {
    const r = await report();
    const unsourced = r.by_source.filter((s) => s.kind === "unsourced_costs");
    expect(unsourced).toEqual([
      { kind: "unsourced_costs", source_id: null, source_name: null, leads: 0, deals: 0, revenue: 0, cost: 5000, cost_per_lead: null, roi: null },
    ]);
    expect(r.by_source[r.by_source.length - 1].kind).toBe("unsourced_costs");
    // no 'source' row without a source here: no lead or deal of the period lacks one
    expect(r.by_source.filter((s) => s.kind === "source" && s.source_id === null)).toEqual([]);
  });

  it("matches a campaign ignoring case and outer spaces; a cost with no source meets its campaign across every source", async () => {
    const r = await report();
    const winter = r.by_campaign.filter((c) => c.kind === "source" && c.source_id === facebook && c.campaign.toLowerCase() === "winter");
    expect(winter).toHaveLength(1);
    expect(winter[0]).toMatchObject({ leads: 2, deals: 1, revenue: 300000, cost: 100000, cost_per_lead: 50000, roi: 2 });
    expect(r.by_campaign.find((c) => c.campaign === "Summer")).toMatchObject({ kind: "source", leads: 1, cost: 0, roi: null });
    // the billboard cost (no source) meets google's billboard lead
    expect(r.by_campaign.find((c) => c.kind === "all_sources")).toMatchObject({
      source_id: null,
      campaign: "Billboard",
      leads: 1,
      deals: 0,
      cost: 5000,
      cost_per_lead: 5000,
      roi: -1,
    });
    expect(r.by_campaign.find((c) => c.kind === "source" && c.source_id === google)).toMatchObject({ campaign: "billboard", leads: 1, cost: 0 });
    expect(r.by_campaign.reduce((sum, c) => sum + (c.cost ?? 0), 0)).toBe(105000);
  });

  it("a month counts when its first day is in the period", async () => {
    const mid = await asAdmin(async (q) => (await q<{ t: string }>("select ($1::timestamptz + interval '1 day')::text as t", [range[0]])).rows[0].t);
    expect((await report(owner, mid)).totals.cost).toBe(0);
    const wide = await asAdmin(async (q) => (await q<{ t: string }>("select ($1::timestamptz - interval '1 month')::text as t", [range[0]])).rows[0].t);
    expect((await report(owner, wide)).totals.cost).toBe(125000 + 999999);
  });

  // review 2: BAL/COL's partial rule; owner (65) ד: the costs follow app.can_view_costs
  it("full only for those who may view costs and read every counted record; partial otherwise, with no cost", async () => {
    const full = await report();
    const isFull = (r: Report) => {
      expect(r.partial).toBe(false);
      expect(r.totals).toEqual(full.totals);
    };
    const isPartial = (r: Report) => {
      expect(r.partial).toBe(true);
      expect(r.totals).toMatchObject({ cost: null, cost_entries: null, cost_per_lead: null, roi: null });
      expect(r.by_source.every((x) => x.kind === "source" && x.cost === null && x.roi === null && x.cost_per_lead === null)).toBe(true);
      expect(r.by_campaign.every((x) => x.kind === "source" && x.cost === null)).toBe(true);
      // the business's cost total never leaves the database
      expect(JSON.stringify(r)).not.toContain("125000");
    };
    // a manager who reads everything, and a member with the grant view_costs who reads everything: full
    isFull(await report(manager));
    isFull(await report(granted));
    // a member without the grant, and a viewer: partial with their own counts (they read every lead here)
    const m = await report(member);
    isPartial(m);
    expect(m.totals).toMatchObject({ leads: 6, deals: 1, revenue: 300000 });
    isPartial(await report(viewer));
    // a manager with 'team' visibility (in no team) and the granted member with 'own' visibility read fewer: partial
    for (const visibility of ["team", "own"]) {
      await asAdmin((q) => q("update public.organizations set record_visibility = $2 where id = $1", [org, visibility]));
      try {
        const r = await report(visibility === "team" ? manager : granted);
        isPartial(r);
        expect(r.totals.leads).toBeLessThan(6);
      } finally {
        await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      }
    }
    // the counts the report compares with: members only, counts only
    const outsider = await createUser("roi-counts");
    await createOrg(outsider.id, "זר");
    expect(
      await asUser(outsider.id, async (q) => (await q("select * from app.campaign_roi_counts($1, $2, $3)", [org, range[0], range[1]])).rows),
    ).toEqual([{ leads: null, deals: null }]);
    expect(
      await asUser(member.id, async (q) => (await q("select * from app.campaign_roi_counts($1, $2, $3)", [org, range[0], range[1]])).rows),
    ).toEqual([{ leads: "6", deals: "1" }]);
  });

  // review 6: the plan key; an outsider learns nothing
  it("answers {allowed: false} without the plan key and to someone outside the business", async () => {
    const outsider = await createUser("roi-outsider");
    await createOrg(outsider.id, "אחר");
    expect(await answer(outsider)).toEqual({ allowed: false });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"campaign_costs\": false}' where organization_id = $1", [org]));
    try {
      expect(await answer(owner)).toEqual({ allowed: false });
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'campaign_costs' where organization_id = $1", [org]));
    }
    expect((await answer(owner)).allowed).toBe(true);
  });

  it("a cost names a source or a campaign, a month's first day and a positive amount in ILS", async () => {
    expect((await pgError(cost({ amount_agorot: 100 }))).hint).toBe("campaign_cost:key");
    expect((await pgError(cost({ campaign: "x", month: `${monthStart.slice(0, 8)}15` }))).code).toBe("23514");
    expect((await pgError(cost({ campaign: "x", amount_agorot: 0 }))).code).toBe("23514");
    expect((await pgError(cost({ campaign: " x" }))).code).toBe("23514");
    expect((await pgError(cost({ campaign: "x", currency: "USD" }))).code).toBe("23514");
    // owner (65) ד: a member without the grant view_costs and a viewer do not write; a manager and the granted member do
    expect((await pgError(cost({ campaign: "x" }, member))).code).toBe("42501");
    expect((await pgError(cost({ campaign: "x" }, viewer))).code).toBe("42501");
    for (const user of [manager, granted]) {
      const id = await cost({ campaign: "כותב", amount_agorot: 100 }, user);
      expect(await asUser(user.id, async (q) => (await q("delete from public.campaign_costs where id = $1", [id])).rowCount)).toBe(1);
    }
    // a source of another business is refused by the composite key
    const other = await createUser("roi-other");
    const otherOrg = await createOrg(other.id, "עסק שני");
    const foreign = await asUser(other.id, async (q) =>
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'זר') returning id", [otherOrg])).rows[0].id,
    );
    expect((await pgError(cost({ source_id: foreign }))).code).toBe("23503");
  });

  it("removing a source keeps its costs, counted in the row of costs with no source", async () => {
    const temp = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.lead_sources (organization_id, name) values ($1, 'זמני') returning id", [org])).rows[0].id,
    );
    const id = await cost({ source_id: temp, amount_agorot: 700 });
    await asUser(owner.id, (q) => q("delete from public.lead_sources where id = $1", [temp]));
    const row = await asAdmin(async (q) => (await q<{ source_id: string | null }>("select source_id from public.campaign_costs where id = $1", [id])).rows[0]);
    expect(row.source_id).toBeNull();
    expect((await report()).by_source.find((s) => s.kind === "unsourced_costs")!.cost).toBe(5700);
    await asUser(owner.id, (q) => q("delete from public.campaign_costs where id = $1", [id]));
  });

  // review 5: the check trigger's outsider guard comes first: never a campaign_cost:* or vat:* hint to someone who may not write
  it("someone who may not write costs gets RLS's plain refusal, never the check's hints", async () => {
    for (const user of [member, viewer]) {
      expect(await pgError(cost({ campaign: null, source_id: null }, user))).toMatchObject({ code: "42501" });
      expect((await pgError(cost({ campaign: "x", amount_includes_vat: true }, user))).hint).toBeUndefined();
      expect((await pgError(cost({ campaign: "x", month: "2000-01-01", amount_includes_vat: true }, user))).code).toBe("42501");
    }
    const stranger = await createUser("roi-guard");
    await createOrg(stranger.id, "זר אחר");
    expect((await pgError(cost({ campaign: null }, stranger))).code).toBe("42501");
  });

  // owner (63) ב: a cost typed with VAT is counted before VAT at its month's rate, half up; only a business that charges VAT
  it("app.amount_before_vat equals amountBeforeVat() on the shared fixture", async () => {
    const cases = JSON.parse(readFileSync(path.resolve(__dirname, "../unit/fixtures/amount-before-vat.json"), "utf8")) as Array<{
      amount: number;
      rate_bp: number;
      expected: number | null;
    }>;
    for (const c of cases) {
      const got = await asAdmin(async (q) => (await q<{ v: string | null }>("select app.amount_before_vat($1, $2)::text as v", [c.amount, c.rate_bp])).rows[0].v);
      expect(got === null ? null : Number(got), `${c.amount} @ ${c.rate_bp}`).toBe(c.expected);
    }
  });

  it("a cost typed with VAT counts before VAT; only a business that charges VAT marks one", async () => {
    // no VAT status yet: refused
    expect((await pgError(cost({ campaign: "מע\"מ", amount_agorot: 11800, amount_includes_vat: true }))).hint).toBe("campaign_cost:vat");
    await asAdmin((q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [org],
      ),
    );
    const rate = await asAdmin(async (q) => (await q<{ r: number }>("select app.vat_rate_at($1::date) as r", [monthStart])).rows[0].r);
    const id = await cost({ campaign: "מע\"מ", amount_agorot: 11800, amount_includes_vat: true });
    const expected = Math.floor((2 * 11800 * 10000 + 10000 + rate) / (2 * (10000 + rate)));
    const row = (await report()).by_campaign.find((c) => c.campaign === 'מע"מ')!;
    expect(row.cost).toBe(expected);
    // a month before the VAT table: refused with the table's hint
    expect((await pgError(cost({ campaign: "ישן", month: "2000-01-01", amount_agorot: 100, amount_includes_vat: true }))).hint).toBe("vat:before_table");
    // a business that stops charging VAT keeps its old marks (counted as typed with VAT) but cannot mark a new one
    await asAdmin((q) => q("update public.org_document_settings set vat_status = 'exempt' where organization_id = $1", [org]));
    try {
      expect((await pgError(cost({ campaign: "פטור", amount_includes_vat: true }))).hint).toBe("campaign_cost:vat");
      expect((await report()).by_campaign.find((c) => c.campaign === 'מע"מ')!.cost).toBe(expected);
      await asUser(owner.id, (q) => q("update public.campaign_costs set note = 'הערה' where id = $1", [id]));
    } finally {
      await asAdmin((q) => q("update public.org_document_settings set vat_status = 'licensed' where organization_id = $1", [org]));
      await asUser(owner.id, (q) => q("delete from public.campaign_costs where id = $1", [id]));
    }
  });

  // owner (61) ב: the plan key campaign_costs (the plans of lead_distribution)
  it("needs the plan key campaign_costs to add or change a cost and to export the report; removing stays allowed", async () => {
    const id = await cost({ campaign: "מפתח", amount_agorot: 300 });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"campaign_costs\": false}' where organization_id = $1", [org]));
    try {
      expect((await pgError(cost({ campaign: "בלי מפתח" }))).hint).toBe("feature:campaign_costs");
      expect((await pgError(asUser(owner.id, (q) => q("update public.campaign_costs set amount_agorot = 400 where id = $1", [id]))))).toMatchObject({
        hint: "feature:campaign_costs",
      });
      expect((await pgError(asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'campaign_roi', 1, 'csv')", [org]))))).toMatchObject({
        hint: "feature:campaign_costs",
      });
      // the source revenue report (SEG-02) stays open
      await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'source_revenue', 1, 'csv')", [org]));
      // an outsider learns nothing of the plan: RLS's plain refusal
      const stranger = await createUser("roi-stranger");
      await createOrg(stranger.id, "זר");
      expect((await pgError(cost({ campaign: "זר" }, stranger))).code).toBe("42501");
      expect(await asUser(owner.id, async (q) => (await q("delete from public.campaign_costs where id = $1", [id])).rowCount)).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'campaign_costs' where organization_id = $1", [org]));
    }
    // the plans: personal off, basic and up on, a plan without the key off
    const flags = await asAdmin(async (q) =>
      (await q<{ key: string; f: boolean | null }>("select key, (features ->> 'campaign_costs')::boolean as f from public.plans")).rows,
    );
    expect(Object.fromEntries(flags.map((r) => [r.key, r.f]))).toMatchObject({ personal: false, basic: true, pro: true, business: true, free: false });
  });

  it("is audited and exported like the other reports", async () => {
    const id = await cost({ campaign: "audit", amount_agorot: 1234 });
    await asUser(owner.id, (q) => q("update public.campaign_costs set amount_agorot = 4321 where id = $1", [id]));
    await asUser(owner.id, (q) => q("delete from public.campaign_costs where id = $1", [id]));
    const actions = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where entity_type = 'campaign_costs' and entity_id = $1 order by created_at, id", [id])).rows.map(
        (r) => r.action,
      ),
    );
    expect(actions).toEqual(["insert", "update", "delete"]);
    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'campaign_roi', 3, 'csv')", [org]));
  });
});

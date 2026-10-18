import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type CategoryRow = {
  kind: "category" | "uncategorized" | "free";
  category_id: string | null;
  name: string | null;
  parent_id: string | null;
  parent_name: string | null;
  billing: string | null;
  products: number;
  deals: number;
  amount: number;
};
type Categories = {
  totals: Record<string, number>;
  by_billing: { billing: string | null; lines: number; deals: number; amount: number }[];
  by_category: CategoryRow[];
  by_top: { category_id: string; name: string; billing: string | null; products: number; deals: number; amount: number }[];
};
type ProfitRow = {
  product_id: string | null;
  name: string | null;
  billing: string | null;
  quantity: number;
  deals: number;
  revenue: number;
  cost: number;
  profit: number;
  margin_bp: number | null;
};
type Profit =
  | { allowed: false }
  | {
      allowed: true;
      totals: { deals: number; deals_with_costs: number; lines: number; costed_lines: number; uncosted_lines: number };
      by_billing: { billing: string | null; lines: number; deals: number; revenue: number; cost: number; profit: number; margin_bp: number | null }[];
      by_product: ProfitRow[];
    };

// DLI-06: revenue by product category, and gross profit from the cost kept on each deal line (PRD-06 follow-up) for
// those who may see costs only.
describe("revenue by category and gross profit (DLI-06)", () => {
  let owner: { id: string }, manager: { id: string }, rep: { id: string }, costRep: { id: string }, exporter: { id: string };
  let viewer: { id: string }, outsider: { id: string };
  let org: string, outsiderOrg: string;
  let pipelineId: string, openStage: string, wonStage: string, lostStage: string;
  let furniture: string, chairs: string;
  let chair: string, table: string, lamp: string, hosting: string;
  let gross: string;
  const from = () => new Date(Date.now() - 86_400_000).toISOString();
  const to = () => new Date(Date.now() + 86_400_000).toISOString();

  const run = <T>(fn: string, userId: string, args: { owner?: string | null; orgId?: string } = {}) =>
    asUser(userId, async (q) =>
      (await q<{ r: T }>(`select public.${fn}($1, $2, $3, null, $4) as r`, [args.orgId ?? org, from(), to(), args.owner ?? null])).rows[0].r,
    );
  const categories = (userId: string, args: { owner?: string | null; orgId?: string } = {}) => run<Categories>("report_revenue_by_category", userId, args);
  const profit = (userId: string, args: { owner?: string | null; orgId?: string } = {}) => run<Profit>("report_gross_profit", userId, args);
  const allowed = (r: Profit) => {
    if (!r.allowed) throw new Error("expected the report");
    return r;
  };
  const grant = (user: string, keys: string[]) => asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, user, keys]));
  const deal = (userId: string, name: string) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, $2, $3, $4, $5) returning id", [
          org,
          name,
          pipelineId,
          openStage,
          userId,
        ])
      ).rows[0].id,
    );
  const line = (userId: string, dealId: string, values: { product?: string; description: string; quantity: number; price: number; billing?: string }) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.deal_lines (organization_id, deal_id, product_id, description, quantity, unit_price_agorot, price_source, billing)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [org, dealId, values.product ?? null, values.description, values.quantity, values.price, values.product ? "product" : "manual", values.billing ?? null],
        )
      ).rows[0].id,
    );
  const close = (dealId: string, stage: string) => asAdmin((q) => q("update public.deals set stage_id = $2 where id = $1", [dealId, stage]));
  const setCost = (productId: string, agorot: number) =>
    asUser(owner.id, (q) =>
      q(
        "insert into public.product_costs (organization_id, product_id, cost_agorot) values ($1, $2, $3) on conflict (organization_id, product_id) do update set cost_agorot = excluded.cost_agorot",
        [org, productId, agorot],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("dli06-owner");
    org = await createOrg(owner.id);
    manager = await addMember(org, owner.id, "manager", "dli06-manager");
    rep = await addMember(org, owner.id, "member", "dli06-rep");
    costRep = await addMember(org, owner.id, "member", "dli06-cost-rep");
    exporter = await addMember(org, owner.id, "member", "dli06-exporter");
    viewer = await addMember(org, owner.id, "viewer", "dli06-viewer");
    outsider = await createUser("dli06-outsider");
    outsiderOrg = await createOrg(outsider.id);
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = feature_overrides || '{\"granular_permissions\": true}'::jsonb where organization_id = $1", [org]),
    );
    await grant(costRep.id, ["view_costs"]);
    await grant(exporter.id, ["export"]);
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    lostStage = pipe.stages.find((s) => s.kind === "lost")!.id;
    await asUser(owner.id, async (q) => {
      await q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]);
      furniture = (await q<{ id: string }>("insert into public.product_categories (organization_id, name) values ($1, 'ריהוט') returning id", [org])).rows[0].id;
      chairs = (await q<{ id: string }>("insert into public.product_categories (organization_id, name, parent_id) values ($1, 'כיסאות', $2) returning id", [org, furniture])).rows[0].id;
      const product = async (name: string, category: string | null, billing = "one_time") =>
        (
          await q<{ id: string }>(
            "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat, category_id, billing) values ($1, $2, 10000, 'taxable', false, $3, $4) returning id",
            [org, name, category, billing],
          )
        ).rows[0].id;
      chair = await product("כיסא", chairs);
      table = await product("שולחן", furniture);
      lamp = await product("מנורה", null);
      hosting = await product("אחסון", furniture, "monthly");
    });
    await setCost(chair, 6000);
    await setCost(hosting, 1000);
    await setCost(lamp, 0);

    // rep: a won deal priced before VAT
    const a = await deal(rep.id, "א");
    await line(rep.id, a, { product: chair, description: "כיסא", quantity: 2, price: 10000 });
    await line(rep.id, a, { product: table, description: "שולחן", quantity: 1, price: 30000 });
    await line(rep.id, a, { product: lamp, description: "מנורה", quantity: 1, price: 5000 });
    await line(rep.id, a, { product: hosting, description: "אחסון", quantity: 1, price: 3000 });
    await line(rep.id, a, { description: "התקנה", quantity: 1, price: 2500, billing: "one_time" });
    // the catalog cost changes after the line was made: the report keeps the line's own copy
    await setCost(chair, 9000);
    // manager: a won deal priced with VAT (the business's setting when the deal got its first line)
    await asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = true where organization_id = $1", [org]));
    gross = await deal(manager.id, "ב");
    await line(manager.id, gross, { product: chair, description: "כיסא", quantity: 1, price: 11700 });
    await asUser(owner.id, (q) => q("update public.org_document_settings set prices_include_vat = false where organization_id = $1", [org]));
    // a lost deal with a costed line: never counted
    const lost = await deal(rep.id, "אבד");
    await line(rep.id, lost, { product: chair, description: "כיסא", quantity: 5, price: 10000 });
    for (const id of [a, gross]) await close(id, wonStage);
    await close(lost, lostStage);
  });

  it("revenue by category: each category with its top category, products without a category and free lines apart", async () => {
    const r = await categories(owner.id);
    expect(r.totals).toMatchObject({ deals: 2, deals_with_lines: 2, categories: 2, deals_without_lines: 0, deals_with_vat: 1, deals_without_vat: 1 });
    const grossLine = await asAdmin(async (q) => (await q<{ t: number }>("select total_agorot::int as t from public.deal_lines where deal_id = $1", [gross])).rows[0].t);
    const rows = r.by_category.map((x) => [x.kind, x.name, x.parent_name, x.billing, x.products, x.deals, Number(x.amount)]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ["category", "כיסאות", "ריהוט", "one_time", 1, 2, 20000 + grossLine],
        ["category", "ריהוט", null, "one_time", 1, 1, 30000],
        ["category", "ריהוט", null, "monthly", 1, 1, 3000],
        ["uncategorized", null, null, "one_time", 1, 1, 5000],
        ["free", null, null, "one_time", 0, 1, 2500],
      ]),
    );
    expect(rows).toHaveLength(5);
    // a subcategory rolls up into its top category; one figure per billing
    expect(r.by_top.map((x) => [x.category_id, x.name, x.billing, x.products, Number(x.amount)])).toEqual([
      [furniture, "ריהוט", "one_time", 2, 50000 + grossLine],
      [furniture, "ריהוט", "monthly", 1, 3000],
    ]);
    // the person filter
    const mine = await categories(owner.id, { owner: manager.id });
    expect(mine.by_category.map((x) => [x.name, Number(x.amount)])).toEqual([["כיסאות", grossLine]]);
  });

  it("a won deal in the recycle bin is left out of revenue by category", async () => {
    await asAdmin((q) => q("update public.deals set deleted_at = now() where id = $1", [gross]));
    try {
      const r = await categories(owner.id);
      expect(r.totals.deals).toBe(1);
      expect(r.totals.deals_with_vat).toBe(0);
      expect(r.by_category.find((x) => x.name === "כיסאות")).toMatchObject({ deals: 1, amount: 20000 });
    } finally {
      await asAdmin((q) => q("update public.deals set deleted_at = null where id = $1", [gross]));
    }
  });

  it("revenue by category follows RLS: a rep counts only the deals they read, an outsider nothing", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const r = await categories(rep.id);
      expect(r.totals.deals).toBe(1);
      expect(r.by_category.every((x) => x.deals === 1)).toBe(true);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    const out = await categories(outsider.id);
    expect(out.totals.deals).toBe(0);
    expect(out.by_category).toEqual([]);
    expect((await pgError(asAnon((q) => q("select public.report_revenue_by_category($1, now(), now())", [org])))).code).toBe("42501");
  });

  it("gross profit uses the cost kept on each line, the net amount before VAT, and leaves lines without a cost out", async () => {
    const r = allowed(await profit(owner.id));
    // the VAT-priced line's net amount at the VAT rate of the day the deal was closed
    const net = await asAdmin(async (q) =>
      Number(
        (
          await q<{ n: string }>(
            `select (app.document_totals(jsonb_build_array(jsonb_build_object('quantity', 1, 'unit_price_agorot', 11700, 'vat_exempt', false)),
                     app.vat_rate_at((d.closed_at at time zone 'Asia/Jerusalem')::date), true) ->> 'net_total_agorot') as n
               from public.deals d where d.id = $1`,
            [gross],
          )
        ).rows[0].n,
      ),
    );
    expect(net).toBeLessThan(11700);
    expect(r.totals).toEqual({ deals: 2, deals_with_costs: 2, lines: 6, costed_lines: 4, uncosted_lines: 2 });
    const chairRow = r.by_product.find((x) => x.product_id === chair && x.billing === "one_time")!;
    // 2 x 6000 (the copy kept when the line was made) + 1 x 9000 (the line made after the catalog changed)
    expect([Number(chairRow.quantity), chairRow.deals, chairRow.revenue, chairRow.cost]).toEqual([3, 2, 20000 + net, 12000 + 9000]);
    expect(chairRow.profit).toBe(20000 + net - 21000);
    expect(chairRow.margin_bp).toBe(Math.round(((20000 + net - 21000) * 10000) / (20000 + net)));
    // a cost of 0 counts (a free gift), unlike no cost
    expect(r.by_product.find((x) => x.product_id === lamp)).toMatchObject({ revenue: 5000, cost: 0, profit: 5000, margin_bp: 10000 });
    expect(r.by_product.find((x) => x.product_id === table)).toBeUndefined();
    expect(r.by_product.some((x) => x.product_id === null)).toBe(false);
    // one figure per billing; the monthly line never adds to one-time
    expect(r.by_billing.map((b) => [b.billing, b.lines, b.revenue, b.cost, b.profit])).toEqual([
      ["monthly", 1, 3000, 1000, 2000],
      ["one_time", 3, 25000 + net, 21000, 25000 + net - 21000],
    ]);
  });

  it("gross profit answers nothing to someone who may not see costs, whatever else they read", async () => {
    for (const u of [rep, exporter, viewer]) expect(await profit(u.id)).toEqual({ allowed: false });
    expect(await profit(outsider.id)).toEqual({ allowed: false });
    // the PRM-01 grant and the manager role see it
    expect(allowed(await profit(costRep.id)).totals.costed_lines).toBe(4);
    expect(allowed(await profit(manager.id)).totals.deals).toBe(2);
    // never another business's costs, even for its own owner
    expect(await profit(outsider.id, { orgId: org })).toEqual({ allowed: false });
    expect(allowed(await profit(outsider.id, { orgId: outsiderOrg })).totals.deals).toBe(0);
    expect((await pgError(asAnon((q) => q("select public.report_gross_profit($1, now(), now())", [org])))).code).toBe("42501");
  });

  it("both reports stay security invoker, so RLS on deal_line_costs decides", async () => {
    const definer = await asAdmin(async (q) =>
      (
        await q<{ d: boolean }>(
          "select bool_or(prosecdef) as d from pg_proc where oid in ('public.report_gross_profit'::regproc, 'public.report_revenue_by_category'::regproc)",
        )
      ).rows[0].d,
    );
    expect(definer).toBe(false);
  });

  it("export: the new keys are logged; gross profit only for those who may see costs", async () => {
    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'categories', 3, 'csv')", [org]));
    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'profit', 3, 'xlsx')", [org]));
    await asUser(exporter.id, (q) => q("select public.log_export($1, 'report', 'categories', 3, 'csv')", [org]));
    expect((await pgError(asUser(exporter.id, (q) => q("select public.log_export($1, 'report', 'profit', 3, 'csv')", [org])))).code).toBe("42501");
    await grant(exporter.id, ["export", "view_costs"]);
    await asUser(exporter.id, (q) => q("select public.log_export($1, 'report', 'profit', 3, 'csv')", [org]));
  });
});

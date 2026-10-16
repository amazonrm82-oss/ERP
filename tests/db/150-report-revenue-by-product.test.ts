import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

const billingAmount = (r: { by_billing: { billing: string | null; amount: number }[] }, billing: string | null) =>
  r.by_billing.find((x) => x.billing === billing)?.amount ?? 0;

type Row = { product_id: string | null; name: string | null; billing: string | null; quantity: number; deals: number; amount: number };
type Result = {
  totals: {
    deals: number;
    deals_with_lines: number;
    products: number;
    deals_without_lines: number;
    amount_without_lines: number;
    deals_with_vat: number;
    deals_without_vat: number;
  };
  by_billing: { billing: string | null; lines: number; deals: number; amount: number }[];
  by_product: Row[];
};

// RPT-01: revenue by product, from the stored line totals of the deals won in the period.
describe("revenue by product (RPT-01)", () => {
  let owner: { id: string }, rep: { id: string }, rep2: { id: string };
  let org: string, otherOrg: string;
  let pipelineId: string, openStage: string, wonStage: string, lostStage: string;
  let consulting: string, hosting: string;
  const from = () => new Date(Date.now() - 86_400_000).toISOString();
  const to = () => new Date(Date.now() + 86_400_000).toISOString();

  const report = (userId: string, args: { pipeline?: string | null; owner?: string | null; from?: string; to?: string; orgId?: string } = {}) =>
    asUser(userId, async (q) =>
      (
        await q<{ r: Result }>("select public.report_revenue_by_product($1, $2, $3, $4, $5) as r", [
          args.orgId ?? org,
          args.from ?? from(),
          args.to ?? to(),
          args.pipeline ?? null,
          args.owner ?? null,
        ])
      ).rows[0].r,
    );
  const deal = (userId: string, name: string, amount: number | null = null) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, amount_agorot) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, name, pipelineId, openStage, userId, amount],
        )
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

  beforeAll(async () => {
    owner = await createUser("rpt01-owner");
    org = await createOrg(owner.id);
    rep = await addMember(org, owner.id, "member", "rpt01-rep");
    rep2 = await addMember(org, owner.id, "member", "rpt01-rep2");
    const other = await createUser("rpt01-other");
    otherOrg = await createOrg(other.id);
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    openStage = pipe.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
    lostStage = pipe.stages.find((s) => s.kind === "lost")!.id;
    const product = (name: string, billing: string) =>
      asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat, billing) values ($1, $2, 10000, 'taxable', false, $3) returning id",
            [org, name, billing],
          )
        ).rows[0].id,
      );
    consulting = await product("ייעוץ", "one_time");
    hosting = await product("אחסון", "monthly");

    // rep: two won deals with lines, one won deal without lines, one lost deal with lines
    const a = await deal(rep.id, "א");
    await line(rep.id, a, { product: consulting, description: "ייעוץ", quantity: 2, price: 10000 });
    await line(rep.id, a, { product: hosting, description: "אחסון", quantity: 1, price: 3000 });
    await line(rep.id, a, { description: "התקנה", quantity: 1, price: 2500, billing: "one_time" });
    const b = await deal(rep.id, "ב");
    await line(rep.id, b, { product: consulting, description: "ייעוץ", quantity: 1, price: 12000 });
    const c = await deal(rep.id, "ג", 70000);
    const lost = await deal(rep.id, "אבד");
    await line(rep.id, lost, { product: consulting, description: "ייעוץ", quantity: 5, price: 10000 });
    // rep2: a won deal with a line
    const d = await deal(rep2.id, "ד");
    await line(rep2.id, d, { product: consulting, description: "ייעוץ", quantity: 3, price: 10000 });
    for (const id of [a, b, c, d]) await close(id, wonStage);
    await close(lost, lostStage);
  });

  it("sums the stored line totals of won deals, per product and billing; free lines stand apart", async () => {
    const r = await report(owner.id);
    expect(r.totals).toEqual({
      deals: 4,
      deals_with_lines: 3,
      products: 2,
      deals_without_lines: 1,
      amount_without_lines: 70000,
      deals_with_vat: 0,
      deals_without_vat: 3,
    });
    // one total per billing type: the monthly line is never added to the one-time sales
    expect(r.by_billing).toEqual([
      { billing: "monthly", lines: 1, deals: 1, amount: 3000 },
      { billing: "one_time", lines: 4, deals: 3, amount: 20000 + 2500 + 12000 + 30000 },
    ]);
    expect(r.by_product.map((x) => [x.name, x.billing, Number(x.quantity), x.deals, x.amount])).toEqual([
      ["ייעוץ", "one_time", 6, 3, 62000],
      ["אחסון", "monthly", 1, 1, 3000],
      [null, "one_time", 1, 1, 2500],
    ]);
  });

  it("the totals are the ones stored on the lines: a later price change does not move them", async () => {
    await asUser(owner.id, (q) => q("update public.products set price_agorot = 99999 where id = $1", [consulting]));
    expect((await report(owner.id)).by_product[0].amount).toBe(62000);
  });

  it("filters by owner, pipeline and the closing date", async () => {
    expect((await report(owner.id, { owner: rep2.id })).by_billing).toEqual([{ billing: "one_time", lines: 1, deals: 1, amount: 30000 }]);
    expect((await report(owner.id, { pipeline: "00000000-0000-4000-8000-000000000000" })).totals.deals).toBe(0);
    const past = await report(owner.id, { from: new Date(Date.now() - 10 * 86_400_000).toISOString(), to: new Date(Date.now() - 5 * 86_400_000).toISOString() });
    expect(past.totals.deals).toBe(0);
    expect(past.by_product).toEqual([]);
  });

  it("a deal in the recycle bin leaves the report", async () => {
    const e = await deal(rep2.id, "ה");
    await line(rep2.id, e, { product: hosting, description: "אחסון", quantity: 1, price: 4000 });
    await close(e, wonStage);
    expect(billingAmount(await report(owner.id), "monthly")).toBe(3000 + 4000);
    await asAdmin((q) => q("update public.deals set deleted_at = now() where id = $1", [e]));
    const after = await report(owner.id);
    expect(billingAmount(after, "monthly")).toBe(3000);
    expect(billingAmount(after, "one_time")).toBe(64500);
  });

  it("RLS decides: with 'own' visibility a member counts only their deals; an outsider counts nothing", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const mine = await report(rep2.id);
      expect(mine.totals).toMatchObject({ deals: 1 });
      expect(mine.by_billing).toEqual([{ billing: "one_time", lines: 1, deals: 1, amount: 30000 }]);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    const outsider = await createUser("rpt01-outsider");
    const seen = await report(outsider.id);
    expect(seen.totals.deals).toBe(0);
    expect(seen.by_product).toEqual([]);
    expect((await report(owner.id, { orgId: otherOrg })).totals.deals).toBe(0);
  });

  it("counts a deal won exactly at the start of the period, not one won exactly at its end", async () => {
    const start = "2020-01-01T00:00:00Z";
    const end = "2020-02-01T00:00:00Z";
    const atStart = await deal(rep.id, "בתחילת התקופה");
    await line(rep.id, atStart, { product: consulting, description: "ייעוץ", quantity: 1, price: 1100 });
    const atEnd = await deal(rep.id, "בסוף התקופה");
    await line(rep.id, atEnd, { product: consulting, description: "ייעוץ", quantity: 1, price: 2200 });
    for (const id of [atStart, atEnd]) await close(id, wonStage);
    await asAdmin((q) => q("update public.deals set closed_at = $2 where id = $1", [atStart, start]));
    await asAdmin((q) => q("update public.deals set closed_at = $2 where id = $1", [atEnd, end]));
    const r = await report(owner.id, { from: start, to: end });
    expect(r.totals.deals).toBe(1);
    expect(r.by_billing).toEqual([{ billing: "one_time", lines: 1, deals: 1, amount: 1100 }]);
    // the next period starts exactly where this one ended
    const next = await report(owner.id, { from: end, to: "2020-03-01T00:00:00Z" });
    expect(next.by_billing).toEqual([{ billing: "one_time", lines: 1, deals: 1, amount: 2200 }]);
  });

  it("one product sold with two billing types is two rows; a line saved before billing existed is its own row", async () => {
    const start = "2021-01-01T00:00:00Z";
    const end = "2021-02-01T00:00:00Z";
    const license = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat, billing) values ($1, 'רישיון', 10000, 'taxable', false, 'yearly') returning id",
          [org],
        )
      ).rows[0].id,
    );
    const x = await deal(rep.id, "רישיון שנתי");
    // the business priced this deal with VAT and changed its setting before the next one: the totals say so, so the screen warns
    const vatSetting = (on: boolean) =>
      asAdmin((q) =>
        q(
          `insert into public.org_document_settings (organization_id, prices_include_vat) values ($1, $2)
           on conflict (organization_id) do update set prices_include_vat = excluded.prices_include_vat`,
          [org, on],
        ),
      );
    await vatSetting(true);
    await line(rep.id, x, { product: license, description: "רישיון", quantity: 1, price: 50000 });
    await vatSetting(false);
    await asUser(owner.id, (q) => q("update public.products set billing = 'monthly' where id = $1", [license]));
    const y = await deal(rep.id, "רישיון חודשי");
    await line(rep.id, y, { product: license, description: "רישיון", quantity: 2, price: 5000 });
    const old = await line(rep.id, y, { product: consulting, description: "ייעוץ ישן", quantity: 1, price: 700 });
    // a line saved before DLI-04 has no billing; the triggers would fill it, so they are skipped for this one write
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.deal_lines set billing = null where id = $1", [old]);
    });
    for (const id of [x, y]) await close(id, wonStage);
    for (const id of [x, y]) await asAdmin((q) => q("update public.deals set closed_at = $2 where id = $1", [id, "2021-01-15T10:00:00Z"]));
    const r = await report(owner.id, { from: start, to: end });
    expect(r.by_product.map((row) => [row.name, row.billing, Number(row.quantity), row.deals, row.amount])).toEqual([
      ["רישיון", "yearly", 1, 1, 50000],
      ["רישיון", "monthly", 2, 1, 10000],
      ["ייעוץ", null, 1, 1, 700],
    ]);
    expect(r.by_billing).toEqual([
      { billing: "monthly", lines: 1, deals: 1, amount: 10000 },
      { billing: "yearly", lines: 1, deals: 1, amount: 50000 },
      { billing: null, lines: 1, deals: 1, amount: 700 },
    ]);
    expect(r.totals).toMatchObject({ products: 2, deals_with_vat: 1, deals_without_vat: 1 });
  });

  it("anon cannot run it; the export of the report is logged with its key", async () => {
    expect((await pgError(asAnon((q) => q("select public.report_revenue_by_product($1, now(), now())", [org])))).code).toBe("42501");
    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'products', 3, 'xlsx')", [org]));
    const logged = await asAdmin(async (q) =>
      (await q<{ c: Record<string, unknown> }>("select changes as c from public.audit_log where organization_id = $1 and action = 'export' order by created_at desc limit 1", [org])).rows[0].c,
    );
    expect(logged).toMatchObject({ kind: "report", report: "products", rows: 3, format: "xlsx" });
    expect((await pgError(asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'mrr', 1, 'csv')", [org])))).code).toBe("22023");
  });
});

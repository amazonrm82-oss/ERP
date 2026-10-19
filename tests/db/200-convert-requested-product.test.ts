import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { discountedPrice } from "@/features/price-lists/price";
import { productPriceFor, type ProductPrice } from "@/features/products/price";

import { asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Line = {
  product_id: string | null;
  description: string;
  quantity: string;
  unit_price_agorot: string;
  price_source: string;
  price_list_id: string | null;
  price_list_name: string | null;
  price_includes_vat: boolean;
};

// RVW-27 (migration 020565): converting a lead puts its requested product on the new deal as one line,
// priced like the app prices a new product line (PL-03), when the product is still offerable and the plan
// has products; otherwise the conversion adds no line and still succeeds. The deal value follows (DLI-03).
describe("conversion carries the requested product to the deal (RVW-27)", () => {
  let owner: U;
  let org: string;
  let product: string, archived: string;

  const insert = (table: string, values: Record<string, unknown>) =>
    asAdmin(async (q) => {
      const keys = Object.keys(values);
      const sql = `insert into public.${table} (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [org, ...keys.map((k) => values[k])])).rows[0].id;
    });
  const features = (values: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(values)]));
  const setVat = (status: string | null, includes: boolean) =>
    asAdmin((q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, $2, $3)
         on conflict (organization_id) do update set vat_status = excluded.vat_status, prices_include_vat = excluded.prices_include_vat`,
        [org, status, includes],
      ),
    );
  const convert = (lead: string, amount = 0, createDeal = true) =>
    asUser(owner.id, async (q) => (await q<{ r: { deal_id: string | null } }>("select public.convert_lead($1, $2, null, $3) as r", [lead, createDeal, amount])).rows[0].r);
  const lines = (deal: string) =>
    asAdmin(async (q) =>
      (
        await q<Line>(
          `select product_id, description, quantity::text, unit_price_agorot::text, price_source, price_list_id, price_list_name, price_includes_vat
             from public.deal_lines where deal_id = $1 order by position`,
          [deal],
        )
      ).rows,
    );
  const deal = (id: string) =>
    asAdmin(async (q) => (await q<{ amount: string; source: string | null }>("select amount_agorot::text as amount, amount_source as source from public.deals where id = $1", [id])).rows[0]);
  const rateToday = () =>
    asAdmin(async (q) =>
      Number(
        (
          await q<{ r: number | null }>(
            "select app.vat_rate_at((now() at time zone app.intake_zone((select timezone from public.organizations where id = $1)))::date) as r",
            [org],
          )
        ).rows[0].r ?? 0,
      ),
    );

  beforeAll(async () => {
    owner = await createUser("rp-owner");
    org = await createOrg(owner.id, "עסק המרת מוצר");
    await features({ products: true, price_lists: true });
    product = await insert("products", { name: "ייעוץ שנתי", price_agorot: 11800, price_includes_vat: true, vat_kind: "taxable" });
    archived = await insert("products", { name: "מוצר ישן", price_agorot: 5000 });
  });

  it("the SQL price rules equal the app's (productPriceFor, discountedPrice)", async () => {
    const cases: Array<[ProductPrice, boolean, number]> = [];
    for (const priceAgorot of [0, 1, 99, 11800, 12345, 999999999])
      for (const vatKind of ["taxable", "exempt", "zero_rate"] as const)
        for (const priceIncludesVat of [false, true])
          for (const line of [false, true]) for (const rate of [0, 1700, 1800, 10000]) cases.push([{ priceAgorot, priceIncludesVat, vatKind }, line, rate]);
    const sql = await asAdmin(async (q) =>
      (
        await q<{ v: string }>(
          `select app.product_line_price(c.p, c.i, c.k, c.l, c.r)::text as v
             from jsonb_to_recordset($1::jsonb) as c(n int, p bigint, i boolean, k text, l boolean, r int) order by c.n`,
          [JSON.stringify(cases.map(([p, l, r], n) => ({ n, p: p.priceAgorot, i: p.priceIncludesVat, k: p.vatKind, l, r })))],
        )
      ).rows.map((x) => Number(x.v)),
    );
    expect(sql).toEqual(cases.map(([p, l, r]) => productPriceFor(p, l, r)));

    const discounts: Array<[number, number]> = [];
    for (const price of [0, 1, 5, 15, 11800, 12345, 999999999]) for (const bp of [0, 1, 333, 1000, 5000, 9999, 10000]) discounts.push([price, bp]);
    const sqlDiscounts = await asAdmin(async (q) =>
      (
        await q<{ v: string }>(
          "select app.price_list_discounted(c.p, c.b)::text as v from jsonb_to_recordset($1::jsonb) as c(n int, p bigint, b int) order by c.n",
          [JSON.stringify(discounts.map(([p, b], n) => ({ n, p, b })))],
        )
      ).rows.map((x) => Number(x.v)),
    );
    expect(sqlDiscounts).toEqual(discounts.map(([p, b]) => discountedPrice(p, b)));
  });

  it("the requested product becomes one line of the new deal, in the deal's VAT mode, and the value follows it", async () => {
    await setVat("licensed", false);
    const lead = await insertLead(owner.id, org, { full_name: "דנה מוצר", requested_product_id: product });
    const { deal_id } = await convert(lead);
    const rate = await rateToday();
    const expected = productPriceFor({ priceAgorot: 11800, priceIncludesVat: true, vatKind: "taxable" }, false, rate);
    expect(await lines(deal_id!)).toEqual([
      {
        product_id: product,
        description: "ייעוץ שנתי",
        quantity: "1",
        unit_price_agorot: String(expected),
        price_source: "product",
        price_list_id: null,
        price_list_name: null,
        price_includes_vat: false,
      },
    ]);
    expect(await deal(deal_id!)).toEqual({ amount: String(expected), source: "lines" });

    // a business that charges no VAT: the price as typed
    await setVat("exempt", false);
    const lead2 = await insertLead(owner.id, org, { full_name: "דנה פטורה", requested_product_id: product });
    const second = await convert(lead2);
    expect((await lines(second.deal_id!))[0].unit_price_agorot).toBe("11800");

    // an amount typed in the conversion form is kept (DLI-03); the line is still added
    const lead3 = await insertLead(owner.id, org, { full_name: "דנה סכום", requested_product_id: product });
    const third = await convert(lead3, 5000);
    expect(await lines(third.deal_id!)).toHaveLength(1);
    expect(await deal(third.deal_id!)).toEqual({ amount: "5000", source: null });
  });

  it("the customer's price list sets the price: the tier for quantity 1, falling through a list that is not in force", async () => {
    await setVat("exempt", false);
    const list = await insert("price_lists", { name: "מחירון סוחרים" });
    await insert("price_list_lines", { price_list_id: list, product_id: product, min_quantity: 0, discount_bp: 1000 });
    await insert("price_list_lines", { price_list_id: list, product_id: product, min_quantity: 5, price_agorot: 100 });
    await insert("companies", { name: "סוחרים בע\"מ", owner_id: owner.id, price_list_id: list });
    const lead = await insertLead(owner.id, org, { full_name: "רון סוחר", company_name: "סוחרים בע\"מ", requested_product_id: product });
    const { deal_id } = await convert(lead);
    expect(await lines(deal_id!)).toMatchObject([
      { unit_price_agorot: String(discountedPrice(11800, 1000)), price_source: "price_list", price_list_id: list, price_list_name: "מחירון סוחרים" },
    ]);

    // a fixed tier price for quantity 1: the largest minimum not above 1 wins
    const fixed = await insert("price_lists", { name: "מחירון קבוע" });
    await insert("price_list_lines", { price_list_id: fixed, product_id: product, min_quantity: 0, price_agorot: 9000 });
    await insert("price_list_lines", { price_list_id: fixed, product_id: product, min_quantity: 1, price_agorot: 7000 });
    await insert("companies", { name: "קבועים", owner_id: owner.id, price_list_id: fixed });
    const lead2 = await insertLead(owner.id, org, { full_name: "רון קבוע", company_name: "קבועים", requested_product_id: product });
    expect(await lines((await convert(lead2)).deal_id!)).toMatchObject([{ unit_price_agorot: "7000", price_list_id: fixed }]);

    // an expired list is passed over: the product's own price
    const old = await insert("price_lists", { name: "מחירון ישן", valid_to: "2020-12-31" });
    await insert("price_list_lines", { price_list_id: old, product_id: product, min_quantity: 0, price_agorot: 1 });
    await insert("companies", { name: "ישנים", owner_id: owner.id, price_list_id: old });
    const lead3 = await insertLead(owner.id, org, { full_name: "רון ישן", company_name: "ישנים", requested_product_id: product });
    expect(await lines((await convert(lead3)).deal_id!)).toMatchObject([{ unit_price_agorot: "11800", price_source: "product", price_list_id: null }]);

    // without the price_lists flag no list is used
    await features({ products: true, price_lists: false });
    try {
      const lead4 = await insertLead(owner.id, org, { full_name: "רון בלי", company_name: "סוחרים בע\"מ", requested_product_id: product });
      expect(await lines((await convert(lead4)).deal_id!)).toMatchObject([{ unit_price_agorot: "11800", price_source: "product" }]);
    } finally {
      await features({ products: true, price_lists: true });
    }
  });

  it("nothing is added, and the conversion succeeds, when the product left the catalog, the plan lost products or no deal is made", async () => {
    await setVat("exempt", false);
    const lead = await insertLead(owner.id, org, { full_name: "גיל ארכיון", requested_product_id: archived });
    await asAdmin((q) => q("update public.products set archived_at = now() where id = $1", [archived]));
    const { deal_id } = await convert(lead);
    expect(deal_id).not.toBeNull();
    expect(await lines(deal_id!)).toEqual([]);

    const lead2 = await insertLead(owner.id, org, { full_name: "גיל בלי מוצרים", requested_product_id: product });
    await features({ products: false, price_lists: true });
    try {
      const second = await convert(lead2);
      expect(await lines(second.deal_id!)).toEqual([]);
    } finally {
      await features({ products: true, price_lists: true });
    }

    const lead3 = await insertLead(owner.id, org, { full_name: "גיל בלי עסקה", requested_product_id: product });
    expect((await convert(lead3, 0, false)).deal_id).toBeNull();

    // a lead with no requested product: nothing
    const lead4 = await insertLead(owner.id, org, { full_name: "גיל בלי בקשה" });
    expect(await lines((await convert(lead4)).deal_id!)).toEqual([]);
  });

  it("a merge that hands a kept lead its duplicate's conversion leaves that older deal alone", async () => {
    await setVat("exempt", false);
    const dup = await insertLead(owner.id, org, { full_name: "מאיה כפולה" });
    const { deal_id } = await convert(dup);
    const keep = await insertLead(owner.id, org, { full_name: "מאיה", requested_product_id: product });
    await asUser(owner.id, (q) => q("select public.merge_records($1, 'lead', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    const kept = await asAdmin(async (q) => (await q<{ d: string | null }>("select converted_deal_id as d from public.leads where id = $1", [keep])).rows[0].d);
    expect(kept).toBe(deal_id);
    expect(await lines(deal_id!)).toEqual([]);
  });

  it("the new functions are callable by no role", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ ok: boolean }>(
          `select has_function_privilege(r, f, 'execute') as ok
             from unnest(array['service_role', 'authenticated', 'anon', 'public']) r,
                  unnest(array['app.convert_requested_product()', 'app.product_line_price(bigint, boolean, text, boolean, integer)',
                               'app.price_list_discounted(bigint, integer)']) f`,
        )
      ).rows.map((x) => x.ok),
    );
    expect(rows.every((ok) => ok === false)).toBe(true);
  });
});

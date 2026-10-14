import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { lineTotal } from "@/features/deal-lines/pricing";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Line = {
  id: string;
  total_agorot: string;
  price_includes_vat: boolean;
  vat_exempt: boolean;
  price_source: string;
  price_list_id: string | null;
  price_list_name: string | null;
  unit_price_agorot: string;
  description: string;
};

/**
 * DLI-01, DLI-02, PL-03: product lines on a deal (public.deal_lines). Rights follow the deal
 * (tests 02 and 03); here: the server's columns, the one totals rule, the VAT mode per deal,
 * the plan flags, the cap, the product rules and the price list snapshot.
 */
describe("deal product lines (DLI-01)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const newDeal = (userId: string, name = "עסקה") =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, $2, $3, $4) returning id", [
          org,
          name,
          pipelineId,
          stageId,
        ])
      ).rows[0].id,
    );
  const newProduct = (fields: { name: string; price?: number; vat?: string; includes?: boolean }) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat) values ($1, $2, $3, $4, $5) returning id",
          [org, fields.name, fields.price ?? 10000, fields.vat ?? "taxable", fields.includes ?? false],
        )
      ).rows[0].id,
    );
  const insertLine = (userId: string, values: Record<string, unknown>) =>
    asUser(userId, async (q) => {
      const keys = Object.keys(values);
      const res = await q<Line>(
        `insert into public.deal_lines (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning *`,
        [org, ...Object.values(values)],
      );
      return res.rows[0];
    });
  const line = (id: string) => asAdmin(async (q) => (await q<Line>("select * from public.deal_lines where id = $1", [id])).rows[0]);
  const setFeatures = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const setPricesIncludeVat = (value: boolean) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, prices_include_vat) values ($1, $2)
         on conflict (organization_id) do update set prices_include_vat = excluded.prices_include_vat`,
        [org, value],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("lines-owner");
    org = await createOrg(owner.id, "עסק השורות");
    member = await addMember(org, owner.id, "member", "lines-member");
    outsider = await createUser("lines-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages[0].id;
  });

  it("acceptance 4.6: 100 before VAT, quantity 3, 10% off = 270.00, VAT 48.60, total 318.60 by the one totals rule", async () => {
    const product = await newProduct({ name: "מוצר ב-100" });
    const deal = await newDeal(member.id);
    const created = await insertLine(member.id, {
      deal_id: deal,
      product_id: product,
      description: "מוצר ב-100",
      quantity: 3,
      unit_price_agorot: 10000,
      discount_bp: 1000,
      price_source: "product",
    });
    expect(Number(created.total_agorot)).toBe(27000);
    expect(created.price_includes_vat).toBe(false);
    expect(created.vat_exempt).toBe(false);
    const totals = await asUser(member.id, async (q) =>
      (
        await q<{ t: { vat_agorot: number; total_agorot: number; net_total_agorot: number } }>(
          `select app.document_totals(jsonb_agg(jsonb_build_object('quantity', quantity, 'unit_price_agorot', unit_price_agorot,
                    'discount_bp', discount_bp, 'discount_agorot', discount_agorot, 'vat_exempt', vat_exempt) order by position), 1800, false) as t
             from public.deal_lines where deal_id = $1`,
          [deal],
        )
      ).rows[0].t,
    );
    expect(totals).toMatchObject({ net_total_agorot: 27000, vat_agorot: 4860, total_agorot: 31860 });
    // a changed quantity or discount recomputes the line
    await asUser(member.id, (q) => q("update public.deal_lines set quantity = 1.5, discount_bp = null, discount_agorot = 500 where id = $1", [created.id]));
    expect(Number((await line(created.id)).total_agorot)).toBe(14500);
    // DLI-03: the deal's empty value follows the lines' sum before VAT (tests/db/110-deal-value-lines.test.ts)
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1 and amount_agorot = 14500 and amount_source = 'lines'", [deal]))).toBe(1);
  });

  it("each line's total is the line part of the one totals rule, the same in SQL and in the app (lineTotal)", async () => {
    const deal = await newDeal(member.id);
    const cases = [
      { quantity: 1, unit: 1, bp: null, ag: null },
      { quantity: 0.333, unit: 1001, bp: null, ag: null },
      { quantity: 2.5, unit: 3999, bp: 1250, ag: null },
      { quantity: 7, unit: 12345, bp: null, ag: 999 },
      { quantity: 1000, unit: 1, bp: 3333, ag: null },
      { quantity: 0.001, unit: 49999, bp: 10000, ag: null },
      { quantity: 12.125, unit: 70000, bp: 1, ag: null },
    ];
    for (const c of cases) {
      const saved = await insertLine(member.id, {
        deal_id: deal,
        description: "בדיקה",
        quantity: c.quantity,
        unit_price_agorot: c.unit,
        discount_bp: c.bp,
        discount_agorot: c.ag,
      });
      const app = lineTotal({ quantity: c.quantity, unitPriceAgorot: c.unit, discountBp: c.bp, discountAgorot: c.ag }, saved.price_includes_vat);
      expect(app.ok).toBe(true);
      if (app.ok) expect(Number(saved.total_agorot), JSON.stringify(c)).toBe(app.totals.lines[0].totalAgorot);
    }
  });

  it("a free line may be VAT exempt and then carries no VAT in the totals; a product line keeps the product's (owner, 14 October 2026)", async () => {
    const taxable = await newProduct({ name: "חייב" });
    const exempt = await newProduct({ name: "פטור בקטלוג", vat: "exempt" });
    const deal = await newDeal(member.id);
    const free = await insertLine(member.id, { deal_id: deal, description: "שירות פטור", unit_price_agorot: 10000, vat_exempt: true });
    expect(free.vat_exempt).toBe(true);
    await insertLine(member.id, { deal_id: deal, description: "שירות חייב", unit_price_agorot: 10000 });
    // a product line ignores what the client sends, on insert and on update
    const fromTaxable = await insertLine(member.id, { deal_id: deal, product_id: taxable, description: "חייב", unit_price_agorot: 10000, price_source: "product", vat_exempt: true });
    expect(fromTaxable.vat_exempt).toBe(false);
    const fromExempt = await insertLine(member.id, { deal_id: deal, product_id: exempt, description: "פטור", unit_price_agorot: 10000, price_source: "product", vat_exempt: false });
    expect(fromExempt.vat_exempt).toBe(true);
    await asUser(member.id, (q) => q("update public.deal_lines set vat_exempt = true where id = $1", [fromTaxable.id]));
    await asUser(member.id, (q) => q("update public.deal_lines set vat_exempt = false where id = $1", [fromExempt.id]));
    expect([(await line(fromTaxable.id)).vat_exempt, (await line(fromExempt.id)).vat_exempt]).toEqual([false, true]);
    // VAT only on the two taxable lines: 2 x 100 x 18% = 36.00
    const totals = () =>
      asUser(member.id, async (q) =>
        (
          await q<{ t: { vat_agorot: number; exempt_agorot: number } }>(
            `select app.document_totals(jsonb_agg(jsonb_build_object('quantity', quantity, 'unit_price_agorot', unit_price_agorot,
                      'discount_bp', discount_bp, 'discount_agorot', discount_agorot, 'vat_exempt', vat_exempt) order by position), 1800, false) as t
               from public.deal_lines where deal_id = $1`,
            [deal],
          )
        ).rows[0].t,
      );
    expect(await totals()).toMatchObject({ vat_agorot: 3600, exempt_agorot: 20000 });
    // a free line's choice changes on update, and is kept by an update that does not send it
    await asUser(member.id, (q) => q("update public.deal_lines set vat_exempt = false where id = $1", [free.id]));
    expect((await line(free.id)).vat_exempt).toBe(false);
    await asUser(member.id, (q) => q("update public.deal_lines set vat_exempt = true where id = $1", [free.id]));
    await asUser(member.id, (q) => q("update public.deal_lines set quantity = 2 where id = $1", [free.id]));
    expect((await line(free.id)).vat_exempt).toBe(true);
    // the flag is not the client's on someone else's deal (RLS)
    expect(await asUser(outsider.id, async (q) => (await q("update public.deal_lines set vat_exempt = false where id = $1", [free.id])).rowCount)).toBe(0);
  });

  it("refuses bad quantities and discounts", async () => {
    const deal = await newDeal(member.id);
    for (const [values, code] of [
      [{ quantity: 0 }, "23514"],
      [{ quantity: 1.2345 }, "23514"],
      [{ quantity: 1000001 }, "23514"],
      [{ discount_bp: 1000, discount_agorot: 100 }, "23514"],
      [{ discount_bp: 10001 }, "23514"],
      [{ description: "   " }, "23514"],
    ] as const) {
      const err = await pgError(insertLine(member.id, { deal_id: deal, description: "שורה", unit_price_agorot: 1000, ...values }));
      // the check constraint, or the totals rule that runs first in the trigger (22023, totals:invalid)
      expect([code, "22023"], JSON.stringify(values)).toContain(err.code);
    }
    // a discount above the amount: the totals rule refuses it
    const tooMuch = await pgError(insertLine(member.id, { deal_id: deal, description: "שורה", unit_price_agorot: 1000, discount_agorot: 1001 }));
    expect(tooMuch.hint).toBe("totals:invalid");
    // a free line names no product and is manual
    expect((await pgError(insertLine(member.id, { deal_id: deal, description: "חופשית", price_source: "product" }))).code).toBe("23514");
  });

  it("one VAT mode per deal: the first line takes the business setting, later lines the deal's; a different mode is refused", async () => {
    await setPricesIncludeVat(true);
    const deal = await newDeal(member.id);
    const first = await insertLine(member.id, { deal_id: deal, description: "ראשונה", unit_price_agorot: 11800 });
    expect(first.price_includes_vat).toBe(true);
    await setPricesIncludeVat(false);
    const second = await insertLine(member.id, { deal_id: deal, description: "שנייה", unit_price_agorot: 100 });
    expect(second.price_includes_vat).toBe(true);
    const wrong = await pgError(insertLine(member.id, { deal_id: deal, description: "שלישית", price_includes_vat: false }));
    expect(wrong.hint).toBe("deal_lines:vat_mode");
    // a new deal follows the new setting
    const other = await newDeal(member.id);
    expect((await insertLine(member.id, { deal_id: other, description: "בעסקה אחרת", price_includes_vat: false })).price_includes_vat).toBe(false);
  });

  it("copies the product's VAT kind; only an offerable product can be added; a product on a line is archived, never removed", async () => {
    const exempt = await newProduct({ name: "פטור", vat: "exempt" });
    const deal = await newDeal(member.id);
    const created = await insertLine(member.id, { deal_id: deal, product_id: exempt, description: "פטור", unit_price_agorot: 5000, price_source: "product" });
    expect(created.vat_exempt).toBe(true);

    const inactive = await newProduct({ name: "לא פעיל" });
    await asUser(owner.id, (q) => q("update public.products set is_active = false where id = $1", [inactive]));
    const archived = await newProduct({ name: "בארכיון" });
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [archived]));
    for (const id of [inactive, archived]) {
      const err = await pgError(insertLine(member.id, { deal_id: deal, product_id: id, description: "x", price_source: "product" }));
      expect(err.hint).toBe("deal_lines:product");
    }

    // PRD-03: a later change of the product never changes the line
    await asUser(owner.id, (q) => q("update public.products set price_agorot = 99900, name = 'שם חדש', vat_kind = 'taxable' where id = $1", [exempt]));
    const after = await line(created.id);
    expect([after.unit_price_agorot, after.description, after.vat_exempt]).toEqual(["5000", "פטור", true]);

    // the product cannot be removed while a line uses it, and can be archived
    const removal = await pgError(asUser(owner.id, (q) => q("delete from public.products where id = $1", [exempt])));
    expect(removal.code).toBe("23503");
    expect(removal.message).toContain("deal_lines_product_fk");
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [exempt]));
    expect(await asAdmin((q) => count(q, "select 1 from public.deal_lines where id = $1", [created.id]))).toBe(1);
    // the product of a line is fixed: no client update grant
    expect((await pgError(asUser(member.id, (q) => q("update public.deal_lines set product_id = $1 where id = $2", [inactive, created.id])))).code).toBe("42501");
  });

  it("keeps the price list that set the price, by name, after the list is renamed or removed", async () => {
    const product = await newProduct({ name: "במחירון" });
    const list = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'סיטונאי') returning id", [org])).rows[0].id,
    );
    const deal = await newDeal(member.id);
    const created = await insertLine(member.id, {
      deal_id: deal,
      product_id: product,
      description: "במחירון",
      unit_price_agorot: 9000,
      price_source: "price_list",
      price_list_id: list,
    });
    expect([created.price_list_id, created.price_list_name]).toEqual([list, "סיטונאי"]);
    await asUser(owner.id, (q) => q("update public.price_lists set name = 'שם אחר' where id = $1", [list]));
    expect((await line(created.id)).price_list_name).toBe("סיטונאי");
    // removing the list leaves the line, its price and the name it was priced by
    await asUser(owner.id, (q) => q("delete from public.price_lists where id = $1", [list]));
    const after = await line(created.id);
    expect([after.price_list_id, after.price_list_name, after.unit_price_agorot, after.price_source]).toEqual([null, "סיטונאי", "9000", "price_list"]);
    // a price list price must name its list
    const missing = await pgError(insertLine(member.id, { deal_id: deal, product_id: product, description: "x", price_source: "price_list" }));
    expect(missing.hint).toBe("deal_lines:price_list");
    // the line whose list was removed can still be edited, and keeps the name
    await asUser(member.id, (q) => q("update public.deal_lines set quantity = 2 where id = $1", [created.id]));
    expect((await line(created.id)).price_list_name).toBe("סיטונאי");
    // a typed price drops the list
    await asUser(member.id, (q) => q("update public.deal_lines set price_source = 'manual', unit_price_agorot = 8000 where id = $1", [created.id]));
    const manual = await line(created.id);
    expect([manual.price_source, manual.price_list_id, manual.price_list_name]).toEqual(["manual", null, null]);
  });

  it("a person's price source has its shape: a list price names a list, any other names none (L1/L3)", async () => {
    const product = await newProduct({ name: "צורה" });
    const list = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'קמעונאי') returning id", [org])).rows[0].id,
    );
    const deal = await newDeal(member.id);
    // another source with a list
    const withList = await pgError(
      insertLine(member.id, { deal_id: deal, product_id: product, description: "x", price_source: "product", price_list_id: list }),
    );
    expect(withList.hint).toBe("deal_lines:price_list");
    const created = await insertLine(member.id, { deal_id: deal, product_id: product, description: "x", price_source: "product" });
    // turned into a list price without a list, on update
    const noList = await pgError(asUser(member.id, (q) => q("update public.deal_lines set price_source = 'price_list' where id = $1", [created.id])));
    expect(noList.hint).toBe("deal_lines:price_list");
    // a list on a line whose source is not a list
    const stray = await pgError(asUser(member.id, (q) => q("update public.deal_lines set price_list_id = $1 where id = $2", [list, created.id])));
    expect(stray.hint).toBe("deal_lines:price_list");
    // a list price with its list, then the list cleared by hand while it exists
    await asUser(member.id, (q) => q("update public.deal_lines set price_source = 'price_list', price_list_id = $1 where id = $2", [list, created.id]));
    expect((await line(created.id)).price_list_name).toBe("קמעונאי");
    const cleared = await pgError(asUser(member.id, (q) => q("update public.deal_lines set price_list_id = null where id = $1", [created.id])));
    expect(cleared.hint).toBe("deal_lines:price_list");
  });

  it("setting or changing the price list needs the price_lists flag; removing it does not (L2)", async () => {
    const product = await newProduct({ name: "בלי מחירונים" });
    const [listA, listB] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'א') returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'ב') returning id", [org])).rows[0].id,
    ]);
    const deal = await newDeal(member.id);
    const created = await insertLine(member.id, { deal_id: deal, product_id: product, description: "x", price_source: "price_list", price_list_id: listA });
    await setFeatures(org, { price_lists: false });
    try {
      const add = await pgError(insertLine(member.id, { deal_id: deal, product_id: product, description: "y", price_source: "price_list", price_list_id: listA }));
      expect(add.hint).toBe("feature:price_lists");
      const change = await pgError(asUser(member.id, (q) => q("update public.deal_lines set price_list_id = $1 where id = $2", [listB, created.id])));
      expect(change.hint).toBe("feature:price_lists");
      // a line that keeps its list still changes; dropping the list is allowed
      await asUser(member.id, (q) => q("update public.deal_lines set quantity = 4 where id = $1", [created.id]));
      await asUser(member.id, (q) => q("update public.deal_lines set price_source = 'manual', price_list_id = null where id = $1", [created.id]));
      expect((await line(created.id)).price_list_id).toBeNull();
    } finally {
      await setFeatures(org, {});
    }
  });

  it("needs the products flag for a product line and the discounts flag for a line discount", async () => {
    const product = await newProduct({ name: "בדגל" });
    const deal = await newDeal(member.id);
    const kept = await insertLine(member.id, { deal_id: deal, description: "עם הנחה", unit_price_agorot: 1000, discount_bp: 500 });
    await setFeatures(org, { products: false, discounts: false });
    try {
      const noProducts = await pgError(insertLine(member.id, { deal_id: deal, product_id: product, description: "x", price_source: "product" }));
      expect(noProducts.hint).toBe("feature:products");
      const noDiscounts = await pgError(insertLine(member.id, { deal_id: deal, description: "x", unit_price_agorot: 1000, discount_agorot: 100 }));
      expect(noDiscounts.hint).toBe("feature:discounts");
      const changed = await pgError(asUser(member.id, (q) => q("update public.deal_lines set discount_bp = 600 where id = $1", [kept.id])));
      expect(changed.hint).toBe("feature:discounts");
      // a free line without a discount needs neither; a line that keeps its discount can still change
      await insertLine(member.id, { deal_id: deal, description: "חופשית", unit_price_agorot: 1000 });
      await asUser(member.id, (q) => q("update public.deal_lines set quantity = 2 where id = $1", [kept.id]));
      // removing a discount is allowed
      await asUser(member.id, (q) => q("update public.deal_lines set discount_bp = null where id = $1", [kept.id]));
    } finally {
      await setFeatures(org, {});
    }
  });

  it("an outsider gets RLS's plain refusal, never a plan answer", async () => {
    const deal = await newDeal(member.id);
    await setFeatures(org, { discounts: false });
    try {
      const err = await pgError(
        asUser(outsider.id, (q: Query) =>
          q("insert into public.deal_lines (organization_id, deal_id, description, discount_bp) values ($1, $2, 'x', 100)", [org, deal]),
        ),
      );
      expect(err.code).toBe("42501");
      expect(err.hint ?? null).toBeNull();
    } finally {
      await setFeatures(org, {});
    }
    expect(otherOrg).toBeTruthy();
  });

  it("at most 200 lines in a deal", async () => {
    const deal = await newDeal(member.id);
    await asUser(member.id, (q) =>
      q(
        `insert into public.deal_lines (organization_id, deal_id, position, description)
         select $1, $2, g, 'שורה ' || g from generate_series(1, 200) g`,
        [org, deal],
      ),
    );
    const err = await pgError(insertLine(member.id, { deal_id: deal, description: "201" }));
    expect(err.hint).toBe("deal_lines:max");
  });

  it("a read-only business changes no line; purging the deal removes its lines", async () => {
    const deal = await newDeal(member.id);
    const created = await insertLine(member.id, { deal_id: deal, description: "שורה", unit_price_agorot: 100 });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      await asUser(owner.id, async (q) => {
        expect(await count(q, "select 1 from public.deal_lines where id = $1", [created.id])).toBe(1);
        expect((await q("update public.deal_lines set quantity = 4 where id = $1", [created.id])).rowCount).toBe(0);
        expect((await q("delete from public.deal_lines where id = $1", [created.id])).rowCount).toBe(0);
      });
      expect((await pgError(insertLine(owner.id, { deal_id: deal, description: "x" }))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    await asUser(owner.id, async (q) => {
      await q("update public.deals set deleted_at = now() where id = $1", [deal]);
      await q("delete from public.deals where id = $1", [deal]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.deal_lines where id = $1", [created.id]))).toBe(0);
    // every change of a line is audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'deal_lines' and entity_id = $1", [created.id]))).toBeGreaterThanOrEqual(2);
  });

  it("a sample deal with a product line is real work and is kept (USR-04)", async () => {
    const o = await createUser("lines-sample");
    const id = await createOrg(o.id, "עסק דוגמה");
    await asUser(o.id, (q) => q("select public.sample_data_add($1)", [id]));
    const deal = await asAdmin(async (q) =>
      (await q<{ deal_id: string }>("select deal_id from app.sample_records where organization_id = $1 and deal_id is not null limit 1", [id])).rows[0].deal_id,
    );
    await asUser(o.id, (q) => q("insert into public.deal_lines (organization_id, deal_id, description) values ($1, $2, 'שורה אמיתית')", [id, deal]));
    await asUser(o.id, (q) => q("select public.sample_data_remove($1)", [id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1", [deal]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.deal_lines where deal_id = $1", [deal]))).toBe(1);
  });

  it("every lines table references products with no on delete action (PRD-02)", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ table: string; action: string }>(
          `select c.conrelid::regclass::text as table, c.confdeltype as action
             from pg_constraint c
            where c.contype = 'f' and c.confrelid = 'public.products'::regclass and c.conrelid::regclass::text like '%\\_lines'`,
        )
      ).rows,
    );
    expect(rows.map((r) => r.table).sort()).toEqual(expect.arrayContaining(["deal_lines", "price_list_lines"]));
    for (const row of rows) expect(row.action, row.table).toBe("a");
  });
});

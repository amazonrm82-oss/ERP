import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// PL-02: a price list line is a product with a fixed price or a percentage off its own price,
// from a minimum quantity (quantity tiers).
describe("price list lines (PL-02)", () => {
  let owner: U, owner2: U, member: U;
  let org: string, other: string;
  let list: string, product: string, product2: string, otherProduct: string;

  const insertLine = (userId: string, values: Record<string, unknown>, o = org) =>
    asUser(userId, async (q) => {
      const all: Record<string, unknown> = { price_list_id: list, product_id: product, ...values };
      const keys = Object.keys(all);
      const sql = `insert into public.price_list_lines (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [o, ...keys.map((k) => all[k])])).rows[0].id;
    });
  const newProduct = (userId: string, name: string, o = org) =>
    asUser(userId, async (q) => (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, $2, 10000) returning id", [o, name])).rows[0].id);
  const setFeatures = (o: string, features: Record<string, unknown>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o, JSON.stringify(features)]));

  beforeAll(async () => {
    owner = await createUser("pll-owner");
    owner2 = await createUser("pll-owner2");
    org = await createOrg(owner.id);
    other = await createOrg(owner2.id, "עסק אחר");
    member = await addMember(org, owner.id, "member", "pll-member");
    product = await newProduct(owner.id, "מוצר");
    product2 = await newProduct(owner.id, "מוצר שני");
    otherProduct = await newProduct(owner2.id, "של עסק אחר", other);
    list = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'סיטונאים') returning id", [org])).rows[0].id);
  });

  it("a fixed price or a discount, from a quantity; members read them", async () => {
    const fixed = await insertLine(owner.id, { price_agorot: 9000, price_includes_vat: true });
    const bulk = await insertLine(owner.id, { min_quantity: 10, discount_bp: 1500 });
    const rows = await asUser(member.id, async (q) =>
      (await q<Record<string, unknown>>(
        "select id, min_quantity::text as m, price_agorot::int as p, price_includes_vat as v, discount_bp as d, currency from public.price_list_lines where price_list_id = $1 order by min_quantity",
        [list],
      )).rows,
    );
    expect(rows).toEqual([
      { id: fixed, m: "0.000", p: 9000, v: true, d: null, currency: "ILS" },
      { id: bulk, m: "10.000", p: null, v: false, d: 1500, currency: "ILS" },
    ]);
  });

  it("exactly one of price and discount; a mode only on a fixed price; values in range", async () => {
    const bad = [
      { min_quantity: 1 },
      { min_quantity: 2, price_agorot: 100, discount_bp: 100 },
      { min_quantity: 3, discount_bp: 100, price_includes_vat: true },
      { min_quantity: 4, discount_bp: 0 },
      { min_quantity: 5, discount_bp: 10001 },
      { min_quantity: 6, price_agorot: -1 },
      { min_quantity: -1, price_agorot: 100 },
      { min_quantity: 7, price_agorot: 100, currency: "USD" },
    ];
    for (const values of bad) {
      expect((await pgError(insertLine(owner.id, values))).code, JSON.stringify(values)).toBe("23514");
    }
    // 100% off and a price of zero are allowed
    expect(await insertLine(owner.id, { min_quantity: 1000, discount_bp: 10000 })).toBeTruthy();
    expect(await insertLine(owner.id, { min_quantity: 2000, price_agorot: 0 })).toBeTruthy();
  });

  it("one line per product and minimum quantity (10 and 10.000 are the same tier)", async () => {
    await insertLine(owner.id, { product_id: product2, min_quantity: 10, price_agorot: 500 });
    expect((await pgError(insertLine(owner.id, { product_id: product2, min_quantity: "10.000", discount_bp: 100 }))).code).toBe("23505");
    // a quantity with three decimals is its own tier; a fourth decimal is rounded away by numeric(12,3)
    expect(await insertLine(owner.id, { product_id: product2, min_quantity: "10.5", price_agorot: 450 })).toBeTruthy();
  });

  it("a line never points into another business", async () => {
    // a product of another business, or a list of another business
    expect((await pgError(insertLine(owner.id, { product_id: otherProduct, min_quantity: 3, price_agorot: 1 }))).code).toBe("23503");
    const otherList = await asUser(owner2.id, async (q) => (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'של עסק אחר') returning id", [other])).rows[0].id);
    expect((await pgError(insertLine(owner.id, { price_list_id: otherList, min_quantity: 3, price_agorot: 1 }))).code).toBe("23503");
    // and the other business cannot use our product either, even through its own list
    expect((await pgError(insertLine(owner2.id, { price_list_id: otherList, product_id: product, price_agorot: 1 }, other))).code).toBe("23503");
  });

  it("the list and the product are fixed once inserted; the price fields change", async () => {
    const id = await insertLine(owner.id, { min_quantity: 50, price_agorot: 7000 });
    expect((await pgError(asUser(owner.id, (q) => q("update public.price_list_lines set product_id = $2 where id = $1", [id, product2])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.price_list_lines set price_list_id = price_list_id where id = $1", [id])))).code).toBe("42501");
    const changed = await asUser(owner.id, async (q) =>
      (await q("update public.price_list_lines set price_agorot = null, discount_bp = 2500, min_quantity = 60 where id = $1 returning id", [id])).rowCount,
    );
    expect(changed).toBe(1);
  });

  it("a product a price list uses cannot be removed, only archived; it can be removed once no list uses it", async () => {
    const used = await newProduct(owner.id, "בשימוש במחירון");
    const lineId = await insertLine(owner.id, { product_id: used, price_agorot: 100 });
    const err = await pgError(asUser(owner.id, (q) => q("delete from public.products where id = $1", [used])));
    expect(err.code).toBe("23503");
    expect(err.message).toContain("price_list_lines_product_fk");
    // archived: the line stays, with its price
    await asUser(owner.id, (q) => q("update public.products set archived_at = now(), is_active = false where id = $1", [used]));
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.price_list_lines where id = $1 and price_agorot = 100", [lineId]))).toBe(1);
    await asUser(owner.id, (q) => q("delete from public.price_list_lines where id = $1", [lineId]));
    expect((await asUser(owner.id, (q) => q("delete from public.products where id = $1", [used]))).rowCount).toBe(1);
  });

  it("removing a price list removes its lines, and nothing else", async () => {
    const temp = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'זמני') returning id", [org])).rows[0].id);
    await insertLine(owner.id, { price_list_id: temp, price_agorot: 1 });
    await insertLine(owner.id, { price_list_id: temp, product_id: product2, discount_bp: 1 });
    const before = await asAdmin((q) => count(q, "select 1 from public.price_list_lines where price_list_id = $1", [list]));
    await asUser(owner.id, (q) => q("delete from public.price_lists where id = $1", [temp]));
    expect(await asAdmin((q) => count(q, "select 1 from public.price_list_lines where price_list_id = $1", [temp]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.price_list_lines where price_list_id = $1", [list]))).toBe(before);
    expect(await asAdmin((q) => count(q, "select 1 from public.products where id in ($1, $2)", [product, product2]))).toBe(2);
  });

  it("only owners and admins write; a read-only business keeps reading", async () => {
    expect((await pgError(insertLine(member.id, { min_quantity: 70, price_agorot: 1 }))).code).toBe("42501");
    await asUser(member.id, async (q) => {
      expect((await q("update public.price_list_lines set price_agorot = 1 where price_list_id = $1", [list])).rowCount).toBe(0);
      expect((await q("delete from public.price_list_lines where price_list_id = $1", [list])).rowCount).toBe(0);
    });
    const frozenOwner = await createUser("pll-frozen");
    const frozen = await createOrg(frozenOwner.id, "עסק בקריאה בלבד");
    const frozenProduct = await newProduct(frozenOwner.id, "מוצר", frozen);
    const frozenList = await asUser(frozenOwner.id, async (q) => (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'מחירון') returning id", [frozen])).rows[0].id);
    const lineId = await insertLine(frozenOwner.id, { price_list_id: frozenList, product_id: frozenProduct, price_agorot: 1 }, frozen);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [frozen]));
    expect((await pgError(insertLine(frozenOwner.id, { price_list_id: frozenList, product_id: frozenProduct, min_quantity: 5, price_agorot: 1 }, frozen))).code).toBe("42501");
    await asUser(frozenOwner.id, async (q) => {
      expect((await q("update public.price_list_lines set price_agorot = 2 where id = $1", [lineId])).rowCount).toBe(0);
      expect((await q("delete from public.price_list_lines where id = $1", [lineId])).rowCount).toBe(0);
      expect(await count(q, "select 1 from public.price_list_lines where id = $1", [lineId])).toBe(1);
    });
  });

  it("at most 20 quantity tiers per product in one list", async () => {
    const tiers = await newProduct(owner.id, "מדרגות");
    for (let i = 0; i < 20; i++) await insertLine(owner.id, { product_id: tiers, min_quantity: i, price_agorot: 1000 - i });
    const err = await pgError(insertLine(owner.id, { product_id: tiers, min_quantity: 99, price_agorot: 1 }));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("price_list_lines:tiers");
    // another product in the same list is not affected
    expect(await insertLine(owner.id, { product_id: product2, min_quantity: 99, price_agorot: 1 })).toBeTruthy();
    // an outsider or a member of the business learns nothing about it: a plain 42501
    for (const u of [owner2, member]) {
      const outside = await pgError(insertLine(u.id, { product_id: tiers, min_quantity: 98, price_agorot: 1 }));
      expect(outside.code).toBe("42501");
      expect(outside.hint ?? null).toBeNull();
    }
  });

  it("without the 'price_lists' capability no line can be added, also not by the server", async () => {
    await setFeatures(org, { price_lists: false });
    const err = await pgError(insertLine(owner.id, { min_quantity: 80, price_agorot: 1 }));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("feature:price_lists");
    const serverErr = await pgError(
      asAdmin((q) => q("insert into public.price_list_lines (organization_id, price_list_id, product_id, min_quantity, price_agorot) values ($1, $2, $3, 81, 1)", [org, list, product])),
    );
    expect(serverErr.hint).toBe("feature:price_lists");
    for (const u of [owner2, member]) {
      const outside = await pgError(insertLine(u.id, { min_quantity: 82, price_agorot: 1 }));
      expect(outside.code).toBe("42501");
      expect(outside.hint ?? null).toBeNull();
    }
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.price_list_lines where organization_id = $1", [org]))).toBeGreaterThan(0);
    await setFeatures(org, {});
    const check = await asAdmin(
      async (q) =>
        (await q<{ c: string }>("select with_check as c from pg_policies where tablename = 'price_list_lines' and policyname = 'price_list_lines_insert'")).rows[0].c,
    );
    expect(check).toContain("'price_lists'");
  });

  it("every change is audited", async () => {
    const id = await insertLine(owner.id, { min_quantity: 90, price_agorot: 100 });
    await asUser(owner.id, (q) => q("update public.price_list_lines set price_agorot = 120 where id = $1", [id]));
    await asUser(owner.id, (q) => q("delete from public.price_list_lines where id = $1", [id]));
    const actions = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where entity_type = 'price_list_lines' and entity_id = $1 order by created_at, id", [id])).rows.map((r) => r.action),
    );
    expect(actions).toEqual(["insert", "update", "delete"]);
  });
});

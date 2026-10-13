import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BILLINGS, PRODUCT_KINDS, VAT_KINDS } from "@/features/products/schema";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// PRD-01: the product catalog. Members read; owners and admins of a writable organization write.
describe("products (PRD-01)", () => {
  let owner: U, owner2: U, admin: U, manager: U, member: U, viewer: U;
  let org: string, other: string;
  let unitHour: string, categoryTop: string;

  const insert = (userId: string, values: Record<string, unknown>, o = org) =>
    asUser(userId, async (q) => {
      const keys = Object.keys(values);
      const sql = `insert into public.products (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [o, ...keys.map((k) => values[k])])).rows[0].id;
    });
  const read = (id: string) =>
    asAdmin(async (q) => (await q<Record<string, unknown>>("select * from public.products where id = $1", [id])).rows[0]);

  beforeAll(async () => {
    owner = await createUser("prod-owner");
    owner2 = await createUser("prod-owner2");
    org = await createOrg(owner.id);
    other = await createOrg(owner2.id, "עסק אחר");
    admin = await addMember(org, owner.id, "admin", "prod-admin");
    manager = await addMember(org, owner.id, "manager", "prod-manager");
    member = await addMember(org, owner.id, "member", "prod-member");
    viewer = await addMember(org, owner.id, "viewer", "prod-viewer");
    unitHour = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.product_units where organization_id = $1 and name = 'שעה'", [org])).rows[0].id);
    categoryTop = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.product_categories where organization_id = $1 limit 1", [org])).rows[0].id);
  });

  it("the value lists match the app, and the defaults are a taxable one-time product in shekels", async () => {
    const checks = await asAdmin(async (q) =>
      (await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.products'::regclass and contype = 'c'")).rows.map((r) => r.def),
    );
    for (const [column, values] of [
      ["kind", PRODUCT_KINDS],
      ["vat_kind", VAT_KINDS],
      ["billing", BILLINGS],
    ] as const) {
      const def = checks.find((d) => d.includes(`(${column} = ANY`));
      expect(def, column).toBeDefined();
      expect([...def!.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort(), column).toEqual([...values].sort());
    }
    const id = await insert(owner.id, { name: "ייעוץ" });
    expect(await read(id)).toMatchObject({
      kind: "product",
      vat_kind: "taxable",
      billing: "one_time",
      currency: "ILS",
      price_agorot: "0",
      price_includes_vat: false,
      is_active: true,
      archived_at: null,
    });
  });

  it("checks the values", async () => {
    for (const values of [
      { name: "" },
      { name: " רווח" },
      { name: "x", price_agorot: -1 },
      { name: "x", currency: "USD" },
      { name: "x", kind: "car" },
      { name: "x", vat_kind: "half" },
      { name: "x", billing: "weekly" },
      { name: "x", duration_minutes: 0 },
      { name: "x", duration_minutes: 1441 },
      { name: "x", sku: " A1" },
      { name: "x", barcode: "" },
      // only a taxable product's price can include VAT
      { name: "x", vat_kind: "exempt", price_includes_vat: true },
      { name: "x", vat_kind: "zero_rate", price_includes_vat: true },
    ]) {
      expect((await pgError(insert(owner.id, values))).code, JSON.stringify(values)).toBe("23514");
    }
    const service = await insert(owner.id, {
      name: "שעת ייעוץ",
      kind: "service",
      unit_id: unitHour,
      category_id: categoryTop,
      price_agorot: 35000,
      price_includes_vat: true,
      duration_minutes: 60,
      billing: "monthly",
      vat_kind: "taxable",
    });
    expect(await read(service)).toMatchObject({ kind: "service", duration_minutes: 60, price_agorot: "35000", price_includes_vat: true });
  });

  it("an SKU is unique per organization ignoring case; empty SKUs do not clash", async () => {
    await insert(owner.id, { name: "א", sku: "SKU-1" });
    expect((await pgError(insert(owner.id, { name: "ב", sku: "sku-1" }))).code).toBe("23505");
    await insert(owner.id, { name: "ג" });
    await insert(owner.id, { name: "ד" });
    // another organization may use the same SKU
    await insert(owner2.id, { name: "א", sku: "SKU-1" }, other);
  });

  it("category and unit must be the organization's own; a used unit stays, a removed category leaves the product without one", async () => {
    const [foreignUnit, foreignCategory] = await asAdmin(async (q) => [
      (await q<{ id: string }>("select id from public.product_units where organization_id = $1 limit 1", [other])).rows[0].id,
      (await q<{ id: string }>("select id from public.product_categories where organization_id = $1 limit 1", [other])).rows[0].id,
    ]);
    expect((await pgError(insert(owner.id, { name: "x", unit_id: foreignUnit }))).code).toBe("23503");
    expect((await pgError(insert(owner.id, { name: "x", category_id: foreignCategory }))).code).toBe("23503");

    const unit = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.product_units (organization_id, name) values ($1, 'קופסה') returning id", [org])).rows[0].id);
    const category = await asUser(owner.id, async (q) => (await q<{ id: string }>("insert into public.product_categories (organization_id, name) values ($1, 'זמנית') returning id", [org])).rows[0].id);
    const product = await insert(owner.id, { name: "קופסת ברגים", unit_id: unit, category_id: category });
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.product_units where id = $1", [unit])))).code).toBe("23503");
    await asUser(owner.id, (q) => q("delete from public.product_categories where id = $1", [category]));
    expect(await read(product)).toMatchObject({ unit_id: unit, category_id: null });
  });

  it("every member reads the catalog; only owners and admins of a writable organization change it", async () => {
    const product = await insert(admin.id, { name: "של מנהל המערכת" });
    for (const u of [manager, member, viewer]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.products where id = $1", [product]), "reads").toBe(1);
        expect((await q("update public.products set name = 'x' where id = $1", [product])).rowCount).toBe(0);
        expect((await q("delete from public.products where id = $1", [product])).rowCount).toBe(0);
      });
      expect((await pgError(insert(u.id, { name: "x" }))).code).toBe("42501");
    }
    await asUser(admin.id, async (q) => {
      expect((await q("update public.products set price_agorot = 12345 where id = $1", [product])).rowCount).toBe(1);
    });
    // another organization sees nothing, and the sort fields answer nothing about it
    await asUser(owner2.id, async (q) => {
      expect(await count(q, "select 1 from public.products where organization_id = $1", [org])).toBe(0);
    });
    // organization_id is fixed once inserted
    expect((await pgError(asUser(owner.id, (q) => q("update public.products set organization_id = $2 where id = $1", [product, other])))).code).toBe("42501");

    // read-only: nobody writes, everybody still reads
    const frozen = await createOrg(owner2.id, "עסק בקריאה בלבד");
    const kept = await insert(owner2.id, { name: "נשאר" }, frozen);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [frozen]));
    await asUser(owner2.id, async (q) => {
      expect(await count(q, "select 1 from public.products where id = $1", [kept])).toBe(1);
      expect((await q("update public.products set name = 'x' where id = $1", [kept])).rowCount).toBe(0);
      expect((await q("delete from public.products where id = $1", [kept])).rowCount).toBe(0);
    });
    expect((await pgError(insert(owner2.id, { name: "x" }, frozen))).code).toBe("42501");
  });

  it("a price change is in the audit log with the old and new price", async () => {
    const product = await insert(owner.id, { name: "מחיר משתנה", price_agorot: 10000 });
    await asUser(admin.id, (q) => q("update public.products set price_agorot = 11000 where id = $1", [product]));
    const changes = await asAdmin(async (q) =>
      (
        await q<{ changes: Record<string, { old: unknown; new: unknown }>; actor_id: string }>(
          "select changes, actor_id from public.audit_log where entity_type = 'products' and entity_id = $1 and action = 'update'",
          [product],
        )
      ).rows,
    );
    expect(changes).toHaveLength(1);
    expect(changes[0].actor_id).toBe(admin.id);
    expect(changes[0].changes.price_agorot).toEqual({ old: 10000, new: 11000 });
  });

  it("sorts by category and unit name through sort_category and sort_unit", async () => {
    const product = await insert(owner.id, { name: "ממוין", unit_id: unitHour, category_id: categoryTop });
    const names = await asUser(member.id, async (q) =>
      (await q<{ c: string; u: string }>("select public.sort_category(p) as c, public.sort_unit(p) as u from public.products p where p.id = $1", [product])).rows[0],
    );
    expect(names.u).toBe("שעה");
    expect(names.c).toBeTruthy();
  });
});

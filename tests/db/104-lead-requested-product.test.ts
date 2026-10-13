import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// LEAD-04: leads.requested_product_id (composite FK to products, on delete set null of the column);
// a person may pick only an offerable product (active, not archived) of a plan with 'products'.
describe("requested product on a lead (LEAD-04)", () => {
  let owner: U, member: U, otherOwner: U;
  let org: string, otherOrg: string;
  let product: string, inactive: string, otherProduct: string;

  const newProduct = (userId: string, o: string, name: string, extra: Record<string, unknown> = {}) =>
    asUser(userId, async (q) => {
      const values: Record<string, unknown> = { name, price_agorot: 10000, ...extra };
      const keys = Object.keys(values);
      const sql = `insert into public.products (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await q<{ id: string }>(sql, [o, ...keys.map((k) => values[k])])).rows[0].id;
    });
  const setProduct = (userId: string, lead: string, productId: string | null) =>
    asUser(userId, async (q) => (await q("update public.leads set requested_product_id = $2 where id = $1 returning id", [lead, productId])).rowCount);
  const productOf = (lead: string) =>
    asAdmin(async (q) => (await q<{ p: string | null }>("select requested_product_id as p from public.leads where id = $1", [lead])).rows[0].p);
  const setFeature = (o: string, on: boolean) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o, JSON.stringify({ products: on })]));

  beforeAll(async () => {
    owner = await createUser("rp-owner");
    otherOwner = await createUser("rp-other");
    org = await createOrg(owner.id);
    otherOrg = await createOrg(otherOwner.id, "עסק אחר");
    member = await addMember(org, owner.id, "member", "rp-member");
    await setFeature(org, true);
    await setFeature(otherOrg, true);
    product = await newProduct(owner.id, org, "ייעוץ");
    inactive = await newProduct(owner.id, org, "ישן", { is_active: false });
    otherProduct = await newProduct(otherOwner.id, otherOrg, "של עסק אחר");
  });

  it("a member picks an offerable product on insert and on update, and clears it", async () => {
    const lead = await insertLead(member.id, org, { requested_product_id: product });
    expect(await productOf(lead)).toBe(product);
    const second = await insertLead(member.id, org);
    expect(await setProduct(member.id, second, product)).toBe(1);
    expect(await productOf(second)).toBe(product);
    expect(await setProduct(member.id, second, null)).toBe(1);
    expect(await productOf(second)).toBeNull();
  });

  it("an inactive or archived product cannot be picked", async () => {
    const e = await pgError(insertLead(member.id, org, { requested_product_id: inactive }));
    expect(e.code).toBe("P0001");
    expect(e.hint).toBe("lead:requested_product");
    const archived = await newProduct(owner.id, org, "בארכיון");
    await asUser(owner.id, (q) => q("update public.products set archived_at = now() where id = $1", [archived]));
    const lead = await insertLead(member.id, org);
    expect((await pgError(setProduct(member.id, lead, archived))).hint).toBe("lead:requested_product");
    expect(await productOf(lead)).toBeNull();
  });

  it("a product archived later stays on the lead, and other edits of the lead still save", async () => {
    const later = await newProduct(owner.id, org, "יעבור לארכיון");
    const lead = await insertLead(member.id, org, { requested_product_id: later });
    await asUser(owner.id, (q) => q("update public.products set archived_at = now(), is_active = false where id = $1", [later]));
    await asUser(member.id, (q) => q("update public.leads set full_name = 'שם חדש', requested_product_id = $2 where id = $1", [lead, later]));
    expect(await productOf(lead)).toBe(later);
  });

  it("a product of another business cannot be set (RLS read and composite foreign key)", async () => {
    const lead = await insertLead(member.id, org);
    expect((await pgError(setProduct(member.id, lead, otherProduct))).hint).toBe("lead:requested_product");
    // the server is not checked by the trigger, but the foreign key holds
    expect((await pgError(asAdmin((q) => q("update public.leads set requested_product_id = $2 where id = $1", [lead, otherProduct])))).code).toBe("23503");
  });

  it("without the plan flag a person cannot pick a product (and an unchanged one still saves)", async () => {
    const lead = await insertLead(member.id, org, { requested_product_id: product });
    await setFeature(org, false);
    try {
      const fresh = await insertLead(member.id, org);
      const e = await pgError(setProduct(member.id, fresh, product));
      expect(e.hint).toBe("feature:products");
      await asUser(member.id, (q) => q("update public.leads set full_name = 'בלי קטלוג', requested_product_id = $2 where id = $1", [lead, product]));
      expect(await productOf(lead)).toBe(product);
      // clearing is always allowed
      expect(await setProduct(member.id, lead, null)).toBe(1);
    } finally {
      await setFeature(org, true);
    }
  });

  it("server writers are trusted (an intake or merge may keep any product of the business)", async () => {
    const lead = await insertLead(member.id, org);
    await asAdmin((q) => q("update public.leads set requested_product_id = $2 where id = $1", [lead, inactive]));
    expect(await productOf(lead)).toBe(inactive);
  });

  it("removing an unused product clears it on the lead only", async () => {
    const temp = await newProduct(owner.id, org, "זמני");
    const lead = await insertLead(member.id, org, { requested_product_id: temp, full_name: "נשאר" });
    await asUser(owner.id, (q) => q("delete from public.products where id = $1", [temp]));
    const row = await asAdmin(async (q) => (await q<{ p: string | null; n: string; o: string }>("select requested_product_id as p, full_name as n, organization_id as o from public.leads where id = $1", [lead])).rows[0]);
    expect(row).toEqual({ p: null, n: "נשאר", o: org });
  });

  it("an outsider inserting a lead with a product gets RLS's plain refusal, no hint", async () => {
    // the other business's own product, and a product of this business
    for (const productId of [otherProduct, product]) {
      const e = await pgError(insertLead(otherOwner.id, org, { requested_product_id: productId }));
      expect(e.code).toBe("42501");
      expect(e.hint ?? null).toBeNull();
    }
  });

  it("an outsider changes nothing", async () => {
    const lead = await insertLead(member.id, org);
    expect(await setProduct(otherOwner.id, lead, otherProduct)).toBe(0);
    expect(await productOf(lead)).toBeNull();
  });

  it("sorts by the product's name through sort_requested_product", async () => {
    const lead = await insertLead(member.id, org, { requested_product_id: product });
    const name = await asUser(member.id, async (q) =>
      (await q<{ n: string | null }>("select public.sort_requested_product(l) as n from public.leads l where l.id = $1", [lead])).rows[0].n,
    );
    expect(name).toBe("ייעוץ");
  });
});

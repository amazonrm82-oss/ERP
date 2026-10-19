import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type OrderRow = {
  status: string;
  number: string | null;
  contact_id: string | null;
  delivery_contact_id: string | null;
  company_id: string | null;
  total_agorot: string;
};

// ORD-01 follow-up (migration 020590): a merge moves orders in app.merge_move_links, like quotes, and the `merged`
// entry's trigger (app.merge_orders, 020570) no longer moves anything, so nothing moves twice.
describe("a merge moves orders through app.merge_move_links (ORD-01)", () => {
  let owner: U, outsider: U;
  let org: string, otherOrg: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const insertAs = (u: U, orgId: string, table: string, values: Record<string, unknown>) =>
    asUser(u.id, async (q) => {
      const keys = Object.keys(values);
      const sql = `insert into public.${table} (organization_id, ${keys.join(", ")}) values ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")}) returning id`;
      return (await one<{ id: string }>(q, sql, [orgId, ...keys.map((k) => values[k])])).id;
    });
  const contact = (name: string, u = owner, orgId = org) => insertAs(u, orgId, "contacts", { first_name: name, owner_id: u.id });
  const company = (name: string, u = owner, orgId = org) => insertAs(u, orgId, "companies", { name, owner_id: u.id });
  /** A numbered order (draft, one line, confirmed). */
  const numbered = async (fields: Record<string, unknown>, u = owner, orgId = org) => {
    const id = await insertAs(u, orgId, "orders", fields);
    await asUser(u.id, (q) => q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [orgId, id]));
    await asUser(u.id, (q) => q("select public.order_confirm($1, $2)", [orgId, id]));
    return id;
  };
  const order = (id: string) =>
    asAdmin((q) =>
      one<OrderRow>(q, "select status, number::text, contact_id, delivery_contact_id, company_id, total_agorot::text from public.orders where id = $1", [id]),
    );
  const merge = (type: string, keep: string, dup: string, u = owner, orgId = org) =>
    asUser(u.id, (q) => q("select public.merge_records($1, $2, $3, $4, '{}'::jsonb)", [orgId, type, keep, dup]));
  // the orders flag, and a VAT status (an order is numbered only once VAT is known)
  const features = (orgId: string) =>
    asAdmin(async (q) => {
      await q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify({ orders: true })]);
      await q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [orgId]);
    });

  beforeAll(async () => {
    owner = await createUser("mo-owner");
    org = await createOrg(owner.id, "עסק מיזוג הזמנות");
    outsider = await createUser("mo-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await features(org);
    await features(otherOrg);
  });

  it("contacts: the duplicate's orders and the orders it receives point at the kept contact; nothing else changes", async () => {
    const keep = await contact("רינה");
    const dup = await contact("רינה כפולה");
    const own = await numbered({ contact_id: dup });
    const delivered = await numbered({ contact_id: keep, delivery_contact_id: dup });
    const draft = await insertAs(owner, org, "orders", { contact_id: dup, delivery_contact_id: dup });
    const before = await order(own);

    await merge("contact", keep, dup);
    expect(await order(own)).toEqual({ ...before, contact_id: keep });
    expect(await order(delivered)).toMatchObject({ contact_id: keep, delivery_contact_id: keep, status: "new" });
    expect(await order(draft)).toMatchObject({ contact_id: keep, delivery_contact_id: keep, status: "draft", number: null });
  });

  it("companies: the duplicate's orders point at the kept company", async () => {
    const keep = await company("גלבוע בע\"מ");
    const dup = await company("גלבוע");
    const id = await numbered({ company_id: dup });
    const before = await order(id);
    await merge("company", keep, dup);
    expect(await order(id)).toEqual({ ...before, company_id: keep });
  });

  it("leads: a lead merge moves no order", async () => {
    const c = await contact("לא קשור");
    const id = await numbered({ contact_id: c });
    const before = await order(id);
    const keep = await insertLead(owner.id, org, { full_name: "ליד" });
    const dup = await insertLead(owner.id, org, { full_name: "ליד כפול" });
    await merge("lead", keep, dup);
    expect(await order(id)).toEqual(before);
  });

  it("the server switch for numbered orders is on only for the move and is then put back", async () => {
    const keep = await contact("שחר");
    const dup = await contact("שחר כפול");
    const id = await numbered({ contact_id: dup });
    // inside a savepoint (undone afterwards): a value set before the move is the value after it (the duplicate's removal, later in
    // merge_records, is ORD-01's own detach path and is not part of this move)
    const after = await asAdmin(async (q) => {
      await q("savepoint move_check");
      try {
        await q("select set_config('app.order_server', 'before', true)");
        await q("select app.merge_move_links($1, 'contact', $2, $3)", [org, keep, dup]);
        return (await one<{ s: string | null }>(q, "select current_setting('app.order_server', true) as s")).s;
      } finally {
        await q("rollback to savepoint move_check");
      }
    });
    expect(after).toBe("before");
    // the savepoint undid that move; a full merge moves the numbered (frozen) order for good
    await merge("contact", keep, dup);
    expect((await order(id)).contact_id).toBe(keep);
  });

  it("the `merged` entry no longer moves orders, so nothing moves twice", async () => {
    const a = await contact("אור");
    const b = await contact("אור ב");
    const id = await numbered({ contact_id: b });
    // a `merged` system entry on a that names b, as merge_records writes it: the old trigger moved b's orders here
    await asAdmin((q) =>
      q("insert into public.activities (organization_id, type, body, metadata, contact_id) values ($1, 'system', 'x', $2, $3)", [
        org,
        JSON.stringify({ merged_id: b }),
        a,
      ]),
    );
    expect((await order(id)).contact_id).toBe(b);
    const fn = await asAdmin(async (q) => (await one<{ d: string }>(q, "select pg_get_functiondef('app.merge_orders()'::regprocedure) as d")).d);
    expect(fn).not.toMatch(/update public\.orders/);
  });

  it("one business cannot reach another's orders", async () => {
    // the other business's order on its own contact is untouched by a merge here
    const theirs = await contact("שלהם", outsider, otherOrg);
    const theirOrder = await numbered({ contact_id: theirs }, outsider, otherOrg);
    const keep = await contact("שלנו");
    const dup = await contact("שלנו כפול");
    const ours = await numbered({ contact_id: dup });
    // an outsider cannot merge our records
    expect((await pgError(merge("contact", theirs, dup, outsider, otherOrg))).code).toBe("42501");
    expect((await pgError(merge("contact", keep, dup, outsider, org))).code).toBe("42501");
    expect((await order(ours)).contact_id).toBe(dup);
    // the move is held to the business it is given: our duplicate under the other business's id moves nothing
    await asAdmin((q) => q("select app.merge_move_links($1, 'contact', $2, $3)", [otherOrg, theirs, dup]));
    expect((await order(ours)).contact_id).toBe(dup);
    await merge("contact", keep, dup);
    expect((await order(ours)).contact_id).toBe(keep);
    expect((await order(theirOrder)).contact_id).toBe(theirs);
  });
});

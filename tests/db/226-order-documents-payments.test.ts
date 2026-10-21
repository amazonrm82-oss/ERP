import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrationFile, grantedTables, rerunClosure } from "./rerun";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

/**
 * ORD-06 part two: an order's accounting documents and payments. order_id is set on insert only, to a numbered order of
 * the same business (a draft is refused: order_money:draft), and the row hangs on the order's own deal, else its own
 * contact (order_money:parent). Reading still follows the deal, else the contact. The link never changes by hand; the
 * foreign key's own set-null clears it; a contact merge moves the contact and keeps the order.
 */
describe("documents and payments of an order (ORD-06 part two)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, wonStage: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const newContact = (name: string, orgId = org, u: U = owner) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
  const settings = (orgId: string, u: U) =>
    run(u, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [orgId],
      ),
    );
  // a numbered order from a won deal of `contact`
  const orderFromDeal = async (contact: string) => {
    const deal = await run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'התקנה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          wonStage,
          contact,
          member.id,
        ])
      ).id,
    );
    await run(owner, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity) values ($1, $2, 'התקנה', 50000, 1)", [org, deal]));
    const id = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, deal])).id);
    return { id, deal };
  };
  const doc = (u: U, fields: { order?: string | null; deal?: string | null; contact?: string | null }, orgId = org) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, order_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, 'tax_invoice', $5, 1000) returning id",
          [orgId, fields.order ?? null, fields.deal ?? null, fields.contact ?? null, `OD-${++n}`],
        )
      ).id,
    );
  const pay = (u: U, fields: { order?: string | null; deal?: string | null; contact?: string | null }, orgId = org) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, order_id, deal_id, contact_id, amount_agorot, method) values ($1, $2, $3, $4, 1000, 'cash') returning id",
          [orgId, fields.order ?? null, fields.deal ?? null, fields.contact ?? null],
        )
      ).id,
    );
  const orderOf = (table: string, id: string) => asAdmin(async (q) => (await one<{ order_id: string | null; contact_id: string | null }>(q, `select order_id, contact_id from public.${table} where id = $1`, [id])));

  beforeAll(async () => {
    owner = await createUser("od-owner");
    org = await createOrg(owner.id, "עסק ההזמנות");
    member = await addMember(org, owner.id, "member", "od-member");
    outsider = await createUser("od-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    for (const o of [org, otherOrg]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o, JSON.stringify({ orders: true, documents: true, payments: true })]));
    }
    await settings(org, owner);
    await settings(otherOrg, outsider);
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
  });

  it("a document and a payment hang on a numbered order's deal and name the order; the deal's readers see them", async () => {
    const contact = await newContact("רון");
    const { id: order, deal } = await orderFromDeal(contact);
    const d = await doc(owner, { order, deal, contact });
    const p = await pay(owner, { order, deal });
    expect(await orderOf("accounting_documents", d)).toEqual({ order_id: order, contact_id: contact });
    expect(await orderOf("payments", p)).toMatchObject({ order_id: order });
    // the deal's owner (a member) reads them; listed by the order
    expect(await run(member, (q) => count(q, "select 1 from public.accounting_documents where order_id = $1", [order]))).toBe(1);
    expect(await run(member, (q) => count(q, "select 1 from public.payments where order_id = $1", [order]))).toBe(1);
    expect(await run(outsider, (q) => count(q, "select 1 from public.payments where order_id = $1", [order]))).toBe(0);
    // a member without the recording keys reads them but records nothing on the order
    expect((await pgError(doc(member, { order, deal }))).code).toBe("42501");
    expect((await pgError(pay(member, { order, deal }))).code).toBe("42501");
  });

  it("refuses a draft order, another record, and an order of another business", async () => {
    const contact = await newContact("דנה");
    const other = await newContact("אחרת");
    const draft = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id);
    expect((await pgError(doc(owner, { order: draft, contact }))).hint).toBe("order_money:draft");
    expect((await pgError(pay(owner, { order: draft, contact }))).hint).toBe("order_money:draft");

    const { id: order, deal } = await orderFromDeal(contact);
    const { deal: otherDeal } = await orderFromDeal(other);
    // another deal, no deal at all, or another contact
    for (const fields of [{ order, deal: otherDeal }, { order, contact }, { order, deal, contact: other }]) {
      expect((await pgError(doc(owner, fields))).hint, JSON.stringify(fields)).toBe("order_money:parent");
      expect((await pgError(pay(owner, fields))).hint, JSON.stringify(fields)).toBe("order_money:parent");
    }
    // an order of another business: the other business's owner, in their own business, gets the same refusal
    const theirs = await newContact("זר", otherOrg, outsider);
    expect((await pgError(doc(outsider, { order, contact: theirs }, otherOrg))).hint).toBe("order_money:parent");
    expect((await pgError(pay(outsider, { order, contact: theirs }, otherOrg))).hint).toBe("order_money:parent");
    // and into this business they get RLS's plain refusal
    expect((await pgError(doc(outsider, { order, deal }))).code).toBe("42501");
    expect((await pgError(pay(outsider, { order, deal }))).code).toBe("42501");
  });

  it("the link never changes by hand; the foreign key's own set-null clears it", async () => {
    const contact = await newContact("גל");
    const { id: order, deal } = await orderFromDeal(contact);
    const d = await doc(owner, { order, deal });
    const p = await pay(owner, { order, deal });
    // no update grant on the column for anyone
    expect((await pgError(run(owner, (q) => q("update public.accounting_documents set order_id = null where id = $1", [d])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("update public.payments set order_id = null where id = $1", [p])))).code).toBe("42501");
    // a server removal of the order (never done to a numbered order by a person) leaves the rows, unlinked
    await asAdmin(async (q) => {
      await q("select set_config('app.order_server', 'on', true)");
      await q("delete from public.orders where id = $1", [order]);
    });
    expect(await orderOf("accounting_documents", d)).toMatchObject({ order_id: null });
    expect(await orderOf("payments", p)).toMatchObject({ order_id: null });
  });

  it("an order on a contact only takes rows on that contact; a contact merge keeps the order", async () => {
    const contact = await newContact("שירה");
    const dup = await newContact("שירה כפולה");
    const order = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, dup])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [org, order]));
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, order]));
    const d = await doc(owner, { order, contact: dup });
    const p = await pay(owner, { order, contact: dup });
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, contact, dup]));
    expect(await orderOf("accounting_documents", d)).toEqual({ order_id: order, contact_id: contact });
    expect(await orderOf("payments", p)).toEqual({ order_id: order, contact_id: contact });
    expect(await asAdmin(async (q) => (await one<{ contact_id: string }>(q, "select contact_id from public.orders where id = $1", [order])).contact_id)).toBe(contact);
  });

  it("re-running an older grant file through the closure keeps the order_id insert grant", async () => {
    // the parser: table grants and revokes count; function and schema grants do not
    expect([...grantedTables("revoke all on public.payments from anon; grant insert (order_id) on table public.accounting_documents to authenticated;")].sort()).toEqual([
      "public.accounting_documents",
      "public.payments",
    ]);
    expect([...grantedTables("grant select on public.a, public.b to authenticated; revoke all on table public.c , public.d from anon;")].sort()).toEqual([
      "public.a",
      "public.b",
      "public.c",
      "public.d",
    ]);
    expect([...grantedTables("grant execute on function public.order_confirm(uuid, uuid) to authenticated; grant usage on schema public to anon;")]).toEqual([]);
    for (const suffix of ["_payments.sql", "_accounting_documents.sql"]) {
      const rerun = rerunClosure([migrationFile(suffix)]);
      expect(rerun.files, suffix).toContain(migrationFile("_order_documents_payments.sql"));
      await asAdmin(async (q) => {
        for (const sql of rerun.sql) await q(sql);
      });
    }
    const contact = await newContact("עמית");
    const { id: order, deal } = await orderFromDeal(contact);
    expect(await doc(owner, { order, deal })).toBeTruthy();
    expect(await pay(owner, { order, deal })).toBeTruthy();
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Step = { id: string; amount: number; billed: number | null; paid: number | null };
type Money = {
  id: string;
  status: string;
  total: number;
  partial: boolean;
  billed: number | null;
  paid: number | null;
  requested: number | null;
  billing_state: string | null;
  payment_state: string | null;
  steps: Step[];
};

/**
 * ORD-02 (the rest) and ORD-04 (the rest): an order's billing and payment status, read with RLS. Billed = active tax invoices
 * and tax invoice-receipts less active credit invoices linked to the order; paid = its recorded or confirmed payments; a
 * proforma is a request only; cancelled rows count for nothing; the schedule's steps are covered in order. When the caller
 * does not read every linked row, nothing is worked out (partial).
 */
describe("order billing and payment status (ORD-02, ORD-04)", () => {
  let owner: U, member: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, wonStage: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const newContact = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, member.id])).id);

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
    await run(owner, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity) values ($1, $2, 'התקנה', 100000, 1)", [org, deal]));
    const id = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, deal])).id);
    return { id, deal };
  };

  // a manual order on a contact with a payment schedule (percents in basis points), confirmed
  const scheduledOrder = async (contact: string, price: number, steps: number[]) => {
    const id = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', $3, 1)", [org, id, price]));
    let position = 0;
    for (const bp of steps) {
      await run(owner, (q) =>
        q("insert into public.order_payment_steps (organization_id, order_id, position, name, percent_bp, milestone) values ($1, $2, $3, $4, $5, 'שלב')", [org, id, position, `שלב ${position + 1}`, bp]),
      );
      position += 1;
    }
    await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, id]));
    return id;
  };

  const doc = (type: string, amount: number, fields: { order: string; deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, order_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, fields.order, fields.deal ?? null, fields.contact ?? null, type, `OM-${++n}`, amount],
        )
      ).id,
    );
  const pay = (amount: number, fields: { order: string; deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, order_id, deal_id, contact_id, amount_agorot, method) values ($1, $2, $3, $4, $5, 'transfer') returning id",
          [org, fields.order, fields.deal ?? null, fields.contact ?? null, amount],
        )
      ).id,
    );
  const state = async (u: U, ids: string[], orgId = org): Promise<Money[]> =>
    run(u, async (q) => ((await one<{ s: { orders: Money[] } }>(q, "select public.order_money_state($1, $2::uuid[]) as s", [orgId, ids])).s.orders));
  const stateOf = async (u: U, id: string) => (await state(u, [id]))[0];
  const fields = (u: U, id: string) =>
    run(u, async (q) => one<{ b: string | null; p: string | null }>(q, "select public.billing_state(o) as b, public.payment_state(o) as p from public.orders o where o.id = $1", [id]));
  const totalOf = (id: string) => asAdmin(async (q) => Number((await one<{ t: string }>(q, "select total_agorot::text as t from public.orders where id = $1", [id])).t));

  beforeAll(async () => {
    owner = await createUser("om-owner");
    org = await createOrg(owner.id, "עסק החיובים");
    member = await addMember(org, owner.id, "member", "om-member");
    outsider = await createUser("om-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    for (const o of [org, otherOrg]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o, JSON.stringify({ orders: true, documents: true, payments: true })]));
    }
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')
         on conflict (organization_id) do update set vat_status = 'licensed'`,
        [org],
      ),
    );
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    wonStage = pipe.stages.find((s) => s.kind === "won")!.id;
  });

  it("a new order is not billed and unpaid; each boundary moves the state", async () => {
    const contact = await newContact("רון");
    const { id: order, deal } = await orderFromDeal(contact);
    const total = await totalOf(order);
    expect(total).toBeGreaterThan(100);
    expect(await stateOf(owner, order)).toMatchObject({ partial: false, billed: 0, paid: 0, requested: 0, billing_state: "not_billed", payment_state: "unpaid", total });

    // a proforma is a request, not billing; a receipt bills nothing
    await doc("proforma", total, { order, deal });
    await doc("receipt", 100, { order, deal });
    expect(await stateOf(owner, order)).toMatchObject({ billed: 0, requested: total, billing_state: "not_billed" });

    await doc("tax_invoice", total - 1, { order, deal });
    await pay(total - 1, { order, deal });
    expect(await stateOf(owner, order)).toMatchObject({ billed: total - 1, paid: total - 1, billing_state: "partly_billed", payment_state: "partly_paid" });
    expect(await fields(owner, order)).toEqual({ b: "partly_billed", p: "partly_paid" });

    await doc("tax_invoice_receipt", 1, { order, deal });
    const last = await pay(1, { order, deal });
    expect(await stateOf(owner, order)).toMatchObject({ billed: total, paid: total, billing_state: "billed", payment_state: "paid" });
    expect(await fields(owner, order)).toEqual({ b: "billed", p: "paid" });

    // more than the total stays billed / paid, with the true sums
    const extra = await pay(500, { order, deal });
    expect(await stateOf(owner, order)).toMatchObject({ paid: total + 500, payment_state: "paid" });

    // failed, refunded and cancelled payments count for nothing
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [last]));
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [extra]));
    expect(await stateOf(owner, order)).toMatchObject({ paid: total - 1, payment_state: "partly_paid" });
  });

  it("a credit invoice subtracts; a cancelled document counts for nothing; billed never goes below zero", async () => {
    const contact = await newContact("דנה");
    const { id: order, deal } = await orderFromDeal(contact);
    const total = await totalOf(order);
    const invoice = await doc("tax_invoice", total, { order, deal });
    expect(await stateOf(owner, order)).toMatchObject({ billed: total, billing_state: "billed" });
    await doc("credit_invoice", 1000, { order, deal });
    expect(await stateOf(owner, order)).toMatchObject({ billed: total - 1000, billing_state: "partly_billed" });
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'הוחלפה' where id = $1", [invoice]));
    expect(await stateOf(owner, order)).toMatchObject({ billed: 0, billing_state: "not_billed" });
    expect(await fields(owner, order)).toEqual({ b: "not_billed", p: "unpaid" });
  });

  it("covers the schedule's steps in order, with the cumulative half-up shares", async () => {
    const contact = await newContact("שירה");
    const order = await scheduledOrder(contact, 10000, [3333, 3333, 3334]);
    const total = await totalOf(order);
    const before = await stateOf(owner, order);
    const shares = before.steps.map((s) => s.amount);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
    expect(shares[0]).toBe(Math.round((total * 3333) / 10000));
    expect(before.steps.every((s) => s.billed === 0 && s.paid === 0)).toBe(true);

    await doc("tax_invoice", shares[0] + 10, { order, contact });
    await pay(shares[0], { order, contact });
    const after = await stateOf(owner, order);
    expect(after.steps.map((s) => s.billed)).toEqual([shares[0], 10, 0]);
    expect(after.steps.map((s) => s.paid)).toEqual([shares[0], 0, 0]);
  });

  it("a draft has no state; the list filter finds orders by state", async () => {
    const contact = await newContact("גל");
    const draft = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contact])).id);
    expect(await stateOf(owner, draft)).toMatchObject({ billing_state: null, payment_state: null });
    expect(await fields(owner, draft)).toEqual({ b: null, p: null });
    const { id: order, deal } = await orderFromDeal(contact);
    await doc("tax_invoice", 100, { order, deal });
    const found = await run(owner, (q) =>
      q<{ id: string }>("select o.id from public.orders o where o.organization_id = $1 and public.billing_state(o) = 'partly_billed' and public.payment_state(o) = 'unpaid'", [org]),
    );
    expect(found.rows.map((r) => r.id)).toContain(order);
    expect(found.rows.map((r) => r.id)).not.toContain(draft);
  });

  it("partial: a member who does not read a linked row gets no amounts and no state; the owner gets them", async () => {
    const contact = await newContact("נועה");
    const { id: order, deal } = await orderFromDeal(contact);
    // a document on the deal alone: after the deal is purged it has no parent, so only owners, admins and managers read it
    await doc("tax_invoice", 100, { order, deal });
    await pay(100, { order, deal, contact });
    await run(owner, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    await run(owner, (q) => q("delete from public.deals where id = $1", [deal]));
    // the member still reads the order through its contact, and the payment, but not the document
    expect(await run(member, (q) => count(q, "select 1 from public.orders where id = $1", [order]))).toBe(1);
    expect(await run(member, (q) => count(q, "select 1 from public.accounting_documents where order_id = $1", [order]))).toBe(0);
    expect(await stateOf(member, order)).toMatchObject({ partial: true, billed: null, paid: null, requested: null, billing_state: "unknown", payment_state: "unknown" });
    expect((await stateOf(member, order)).steps.every((s) => s.billed === null && s.paid === null)).toBe(true);
    expect(await fields(member, order)).toEqual({ b: "unknown", p: "unknown" });
    expect(await stateOf(owner, order)).toMatchObject({ partial: false, billed: 100, paid: 100 });
  });

  it("no cross-business data: another business's owner gets nothing, and a stranger's orders are not listed", async () => {
    const contact = await newContact("עמית");
    const { id: order, deal } = await orderFromDeal(contact);
    await doc("tax_invoice", 100, { order, deal });
    expect(await state(outsider, [order])).toEqual([]);
    expect(await state(outsider, [order], otherOrg)).toEqual([]);
    expect(await run(outsider, (q) => count(q, "select 1 from public.orders o where o.id = $1 and public.billing_state(o) is not null", [order]))).toBe(0);
    // the count helper answers nothing to a non-member
    expect(await run(outsider, async (q) => (await one<{ n: string | null }>(q, "select app.order_money_rows($1, $2)::text as n", [org, order])).n)).toBeNull();
  });

  it("refuses more than 500 orders in one call; anon has no access", async () => {
    const ids = Array.from({ length: 501 }, () => "00000000-0000-0000-0000-000000000000");
    expect((await pgError(state(owner, ids))).hint).toBe("order_money:too_many");
    const grants = await asAdmin((q) =>
      q<{ f: string }>(
        `select p.proname as f from pg_proc p
          where p.proname in ('order_money_state', 'billing_state', 'payment_state', 'order_money_rows', 'order_money_sums')
            and has_function_privilege('anon', p.oid, 'execute')`,
      ),
    );
    expect(grants.rows).toEqual([]);
  });
});

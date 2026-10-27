import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string };

// The read rules the definer shortcut app.order_money_facts / app.order_money_same_parent assumes: orders 020570, documents
// 021076 and payments 020635 read the deal, else the contact, else (orders, documents) the company, else the role;
// payment_allocations 020790 and opening_credit_allocations 021077 read the document or the other side. The test
// recreates each as a policy on a temporary copy of its table and compares the server's own rendering of both, so a change
// to a real policy fails here and the shortcut must be reviewed again.
const ROLE_RULE = "coalesce(app.role_in(organization_id) = any (array['owner', 'admin', 'manager']::public.membership_role[]), false)";
const EXPECTED_READ_RULES: Record<string, string> = {
  orders: `case when orders.deal_id is not null
                then exists (select 1 from public.deals d where d.organization_id = orders.organization_id and d.id = orders.deal_id)
                when orders.contact_id is not null
                then exists (select 1 from public.contacts c where c.organization_id = orders.organization_id and c.id = orders.contact_id)
                when orders.company_id is not null
                then exists (select 1 from public.companies c where c.organization_id = orders.organization_id and c.id = orders.company_id)
                else ${ROLE_RULE} end`,
  accounting_documents: `case when accounting_documents.deal_id is not null
                then exists (select 1 from public.deals d where d.organization_id = accounting_documents.organization_id and d.id = accounting_documents.deal_id)
                when accounting_documents.contact_id is not null
                then exists (select 1 from public.contacts c where c.organization_id = accounting_documents.organization_id and c.id = accounting_documents.contact_id)
                when accounting_documents.company_id is not null
                then exists (select 1 from public.companies co where co.organization_id = accounting_documents.organization_id and co.id = accounting_documents.company_id)
                else ${ROLE_RULE} end`,
  payments: `case when payments.deal_id is not null
                then exists (select 1 from public.deals d where d.organization_id = payments.organization_id and d.id = payments.deal_id)
                when payments.contact_id is not null
                then exists (select 1 from public.contacts c where c.organization_id = payments.organization_id and c.id = payments.contact_id)
                else ${ROLE_RULE} end`,
  // the shortcut's allocations (A) and opening credits (C) are read through these: the document OR the other side
  payment_allocations: `exists (select 1 from public.accounting_documents d
                         where d.organization_id = payment_allocations.organization_id and d.id = payment_allocations.document_id)
                or exists (select 1 from public.payments p
                            where p.organization_id = payment_allocations.organization_id and p.id = payment_allocations.payment_id)`,
  opening_credit_allocations: `exists (select 1 from public.accounting_documents d
                         where d.organization_id = opening_credit_allocations.organization_id and d.id = opening_credit_allocations.document_id)
                or exists (select 1 from public.accounting_documents c
                            where c.organization_id = opening_credit_allocations.organization_id and c.id = opening_credit_allocations.credit_document_id)`,
};
type Step = { id: string; amount: number; billed: number | null; paid: number | null };
type Money = {
  id: string;
  status: string;
  total: number;
  partial: boolean;
  billing_partial: boolean;
  payment_partial: boolean;
  has_money: boolean;
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
  // the list filter: is the order in the set for these states?
  const listed = (u: U, id: string, billing: string | null, payment: string | null) =>
    run(u, async (q) => (await q("select 1 from public.orders_by_money_state($1, $2, $3) o where o.id = $4", [org, billing, payment, id])).rowCount === 1);
  const fields = async (u: U, id: string) => {
    const m = await stateOf(u, id);
    // the filter agrees with the page's states
    if (m.billing_state && m.billing_state !== "unknown") expect(await listed(u, id, m.billing_state, null)).toBe(true);
    if (m.payment_state && m.payment_state !== "unknown") expect(await listed(u, id, null, m.payment_state)).toBe(true);
    return { b: m.billing_state, p: m.payment_state };
  };
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
    expect(await listed(owner, draft, null, null)).toBe(false);
    const { id: order, deal } = await orderFromDeal(contact);
    await doc("tax_invoice", 100, { order, deal });
    const found = await run(owner, (q) => q<{ id: string }>("select o.id from public.orders_by_money_state($1, 'partly_billed', 'unpaid') o", [org]));
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
    // a hidden document hides both halves: paid also counts allocations, credits and receipts on the order's documents
    expect(await stateOf(member, order)).toMatchObject({
      partial: true,
      billing_partial: true,
      payment_partial: true,
      billed: null,
      paid: null,
      requested: null,
      billing_state: "unknown",
      payment_state: "unknown",
    });
    expect(await fields(member, order)).toEqual({ b: "unknown", p: "unknown" });
    // an order seen only partly matches no billing state
    for (const b of ["not_billed", "partly_billed", "billed"]) expect(await listed(member, order, b, null)).toBe(false);
    expect(await stateOf(owner, order)).toMatchObject({ partial: false, billed: 100, paid: 100, has_money: true });
  });

  // owner's answers of 27 October 2026: paid = allocated (A) + opening credits (C) + greatest(linked unallocated (F), receipts (R))
  const allocate = (payment: string, document: string, amount: number) =>
    run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, payment, document, amount]));
  const looseDoc = (type: string, amount: number, fields: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, fields.deal ?? null, fields.contact ?? null, type, `OL-${++n}`, amount],
        )
      ).id,
    );
  const loosePay = (amount: number, fields: { deal?: string | null; contact?: string | null; advanceFor?: string; order?: string }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.payments (organization_id, order_id, deal_id, contact_id, amount_agorot, method, is_advance, advance_order_id)
           values ($1, $2, $3, $4, $5, 'transfer', $6, $7) returning id`,
          [org, fields.order ?? null, fields.deal ?? null, fields.contact ?? null, amount, fields.advanceFor !== undefined, fields.advanceFor ?? null],
        )
      ).id,
    );
  const paidOf = async (order: string) => (await stateOf(owner, order)).paid;

  it("a payment counts once: on the order, its advance and allocated to its invoice", async () => {
    const contact = await newContact("פעם אחת");
    const { id: order, deal } = await orderFromDeal(contact);
    const total = await totalOf(order);
    const invoice = await doc("tax_invoice", total, { order, deal });
    const p = await loosePay(total, { order, deal, advanceFor: order });
    await allocate(p, invoice, total);
    expect(await stateOf(owner, order)).toMatchObject({ paid: total, payment_state: "paid", billing_state: "billed" });
  });

  it("a payment allocated to the order's invoice counts its allocation only; an advance counts; a failed one never", async () => {
    const contact = await newContact("הקצאה");
    const { id: order, deal } = await orderFromDeal(contact);
    const invoice = await doc("tax_invoice", 10000, { order, deal });
    const loose = await loosePay(5000, { deal });
    await allocate(loose, invoice, 3000);
    expect(await paidOf(order)).toBe(3000);
    await loosePay(4000, { deal, advanceFor: order });
    expect(await paidOf(order)).toBe(7000);
    // a failed payment's allocation is released: nothing of it counts
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [loose]));
    expect(await paidOf(order)).toBe(4000);
  });

  it("a linked payment allocated to another invoice counts only what is left for the order", async () => {
    const contact = await newContact("שארית");
    const { id: order, deal } = await orderFromDeal(contact);
    const linked = await pay(5000, { order, deal });
    const elsewhere = await looseDoc("tax_invoice", 2000, { deal });
    await allocate(linked, elsewhere, 2000);
    expect(await paidOf(order)).toBe(3000);
  });

  it("a tax invoice-receipt and the order's unallocated payments are not added together: the larger counts", async () => {
    const contact = await newContact("קבלה");
    const { id: order, deal } = await orderFromDeal(contact);
    await doc("tax_invoice_receipt", 1000, { order, deal });
    expect(await paidOf(order)).toBe(1000);
    await pay(600, { order, deal });
    expect(await paidOf(order)).toBe(1000);
    await pay(800, { order, deal });
    expect(await paidOf(order)).toBe(1400);
    // an allocated payment is added on top: it paid an invoice, not the receipt
    const invoice = await doc("tax_invoice", 5000, { order, deal });
    const loose = await loosePay(700, { deal });
    await allocate(loose, invoice, 700);
    expect(await paidOf(order)).toBe(2100);
  });

  it("an opening credit offset onto the order's invoice counts as paid", async () => {
    const contact = await newContact("זיכוי פתיחה");
    const { id: order, deal } = await orderFromDeal(contact);
    const invoice = await doc("tax_invoice", 5000, { order, deal, contact });
    const credit = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, null, -2000, '2026-01-01') as id", [org, contact])).id);
    await run(owner, (q) => q("insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot) values ($1, $2, $3, 1500)", [org, credit, invoice]));
    expect(await paidOf(order)).toBe(1500);
  });

  it("partial for a new source: a payment of another record of the customer, allocated to the order's invoice, hidden from a member", async () => {
    const company = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברת הזמנות', $2) returning id", [org, member.id])).id);
    const mine = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, 'שלי', $2, $3) returning id", [org, member.id, company])).id,
    );
    const theirs = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, 'של אחר', $2, $3) returning id", [org, owner.id, company])).id,
    );
    const { id: order, deal } = await orderFromDeal(mine);
    const invoice = await doc("tax_invoice", 5000, { order, deal, contact: mine });
    const other = await loosePay(2500, { contact: theirs });
    await allocate(other, invoice, 2500);
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await run(member, (q) => count(q, "select 1 from public.payments where id = $1", [other]))).toBe(0);
      expect(await stateOf(member, order)).toMatchObject({ billing_partial: false, payment_partial: true, billed: 5000, paid: null, payment_state: "unknown" });
      expect(await stateOf(owner, order)).toMatchObject({ partial: false, paid: 2500 });
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("no cross-business data: another business's owner gets nothing, and a stranger's orders are not listed", async () => {
    const contact = await newContact("עמית");
    const { id: order, deal } = await orderFromDeal(contact);
    await doc("tax_invoice", 100, { order, deal });
    expect(await state(outsider, [order])).toEqual([]);
    expect(await state(outsider, [order], otherOrg)).toEqual([]);
    expect(await run(outsider, (q) => count(q, "select 1 from public.orders_by_money_state($1, null, null)", [org]))).toBe(0);
    // the count helper answers nothing to a non-member
    expect(await run(outsider, (q) => count(q, "select 1 from app.order_money_facts($1, array[$2::uuid])", [org, order]))).toBe(0);
  });

  it("an order whose total is 0 is billed and paid; a cancelled order with no money says so", async () => {
    const contact = await newContact("אפס");
    const free = await scheduledOrder(contact, 0, []);
    expect(await totalOf(free)).toBe(0);
    expect(await fields(owner, free)).toEqual({ b: "billed", p: "paid" });
    const other = await scheduledOrder(contact, 1000, []);
    await run(owner, (q) => q("update public.orders set status = 'cancelled' where id = $1", [other]));
    expect(await stateOf(owner, other)).toMatchObject({ status: "cancelled", has_money: false, billing_state: "not_billed" });
  });

  it("the shortcut agrees with RLS: for every order, partial exactly when the user does not read every linked row", async () => {
    const orders = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.orders where organization_id = $1 and status <> 'draft'", [org])).rows.map((r) => r.id));
    expect(orders.length).toBeGreaterThan(5);
    // every row the money of an order reads: its documents, and its payments (linked, advance, or allocated to its documents)
    const full = await asAdmin(async (q) =>
      (
        await q<{ id: string; docs: string[]; pays: string[] }>(
          `select o.id,
                  array(select d.id from public.accounting_documents d where d.order_id = o.id)::text[] as docs,
                  array(select p.id from public.payments p
                         where p.order_id = o.id or (p.is_advance and p.advance_order_id = o.id)
                            or p.id in (select a.payment_id from public.payment_allocations a
                                          join public.accounting_documents d on d.id = a.document_id
                                         where d.order_id = o.id and a.released_at is null and a.removed_at is null))::text[] as pays
             from public.orders o where o.id = any ($1::uuid[])`,
          [orders],
        )
      ).rows,
    );
    for (const u of [owner, member]) {
      const seen = await run(u, async (q) => (await q<{ id: string }>("select o.id from public.orders o where o.id = any ($1::uuid[])", [orders])).rows.map((r) => r.id));
      const states = new Map((await state(u, seen)).map((m) => [m.id, m]));
      for (const id of seen) {
        const all = full.find((f) => f.id === id)!;
        const [docs, pays] = await run(u, async (q) => [
          await count(q, "select 1 from public.accounting_documents where id = any ($1::uuid[])", [all.docs]),
          await count(q, "select 1 from public.payments where id = any ($1::uuid[])", [all.pays]),
        ]);
        const m = states.get(id)!;
        const docsHidden = docs < all.docs.length;
        expect(m.billing_partial, `${id} documents`).toBe(docsHidden);
        expect(m.payment_partial, `${id} payments`).toBe(docsHidden || pays < all.pays.length);
      }
    }
  });

  it("the read rules the shortcut relies on are unchanged (app.order_money_same_parent mirrors them; review it before changing this)", async () => {
    // exactly one permissive select policy on each table, and no FOR ALL or restrictive one that could narrow reading
    const policies = await asAdmin(async (q) =>
      (
        await q<{ t: string; name: string; cmd: string; permissive: boolean }>(
          `select c.relname as t, p.polname as name, p.polcmd::text as cmd, p.polpermissive as permissive
             from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname in ('orders', 'accounting_documents', 'payments', 'payment_allocations', 'opening_credit_allocations')
              and (p.polcmd in ('r', '*') or not p.polpermissive)
            order by 1, 2`,
        )
      ).rows,
    );
    expect(policies).toEqual([
      { t: "accounting_documents", name: "accounting_documents_select", cmd: "r", permissive: true },
      { t: "opening_credit_allocations", name: "opening_credit_allocations_select", cmd: "r", permissive: true },
      { t: "orders", name: "orders_select", cmd: "r", permissive: true },
      { t: "payment_allocations", name: "payment_allocations_select", cmd: "r", permissive: true },
      { t: "payments", name: "payments_select", cmd: "r", permissive: true },
    ]);
    // each real read rule equals the expected text, both rendered by this server (pg_get_expr) in the same session; the
    // copies live in pg_temp and are dropped when the transaction ends (on commit drop). A copy has the real table's name, so a self-reference
    // (orders.deal_id) renders the same; every other name is schema-qualified in the expected text.
    const rendered = await asAdmin(async (q) => {
      await q("set local search_path = public");
      const out: Record<string, { real: string; expected: string }> = {};
      for (const [table, rule] of Object.entries(EXPECTED_READ_RULES)) {
        await q(`create temp table ${table} (like public.${table}) on commit drop`);
        await q(`create policy expected_read on pg_temp.${table} for select using (${rule})`);
        const row = (
          await q<{ real: string; expected: string }>(
            `select pg_get_expr(r.polqual, r.polrelid) as real, pg_get_expr(e.polqual, e.polrelid) as expected
               from pg_policy r, pg_policy e
              where r.polrelid = $1::regclass and r.polname = $2 and e.polrelid = $3::regclass and e.polname = 'expected_read'`,
            [`public.${table}`, `${table}_select`, `pg_temp.${table}`],
          )
        ).rows[0];
        out[table] = row;
      }
      return out;
    });
    for (const [table, { real, expected }] of Object.entries(rendered)) expect(real, table).toBe(expected);
  });

  it("refuses more than 100 orders in one call; anon has no access", async () => {
    const ids = Array.from({ length: 101 }, () => "00000000-0000-0000-0000-000000000000");
    expect((await pgError(state(owner, ids))).hint).toBe("order_money:too_many");
    const grants = await asAdmin((q) =>
      q<{ f: string }>(
        `select p.proname as f from pg_proc p
          where p.proname in ('order_money_state', 'billing_state', 'payment_state', 'order_money_rows', 'order_money_facts', 'orders_by_money_state')
            and has_function_privilege('anon', p.oid, 'execute')`,
      ),
    );
    expect(grants.rows).toEqual([]);
  });
});

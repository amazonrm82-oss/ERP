import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Credit = {
  total: number;
  count: number;
  payments: { id: string; paid_on: string; method: string; amount: number; credit: number; is_advance: boolean; advance_quote_id: string | null; advance_order_id: string | null }[];
};
type Applied = { allocated: number; payments: { payment_id: string; amount: number }[] };

/**
 * PAY-03: the customer's credit balance is every unallocated part of a recorded or confirmed payment of the same customer
 * (PAY-02's rule: the deal, the contact, and the deals and contacts of their companies); public.money_customer_credit counts
 * it under RLS, and public.money_apply_credit allocates it to a new tax invoice or proforma, oldest payment first, through
 * ordinary allocation inserts, catching only the refusals a race can cause.
 */
describe("customer credit (PAY-03)", () => {
  let owner: U, manager: U, member: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const company = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const contact = (name: string, companyId: string | null = null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, ownerId])).id,
    );
  const deal = (contactId: string | null, companyId: string | null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5, $6) returning id",
          [org, pipelineId, stageId, contactId, companyId, owner.id],
        )
      ).id,
    );
  const doc = (type: string, amount: number, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, on.deal ?? null, on.contact ?? null, type, `CR-${++n}`, amount],
        )
      ).id,
    );
  const pay = (amount: number, paidOn: string, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, 'transfer') returning id",
          [org, on.deal ?? null, on.contact ?? null, amount, paidOn],
        )
      ).id,
    );
  const credit = (u: U, where: { deal?: string | null; contact?: string | null; company?: string | null }) =>
    run(u, async (q) =>
      (
        await one<{ c: Credit }>(q, "select public.money_customer_credit($1, $2, $3, $4) as c", [org, where.deal ?? null, where.contact ?? null, where.company ?? null])
      ).c,
    );
  const apply = (u: U, document: string, max: number | null = null) =>
    run(u, async (q) => (await one<{ a: Applied }>(q, "select public.money_apply_credit($1, $2, $3) as a", [org, document, max])).a);
  const docState = (id: string) =>
    run(owner, async (q) =>
      (
        await one<{ s: { documents: { paid: number; balance: number; state: string }[] } }>(q, "select public.money_allocation_state($1, $2, '{}') as s", [org, [id]])
      ).s.documents[0],
    );
  const payCredit = (ids: string[]) =>
    run(owner, async (q) =>
      new Map(
        (await one<{ s: { payments: { id: string; credit: number }[] } }>(q, "select public.money_allocation_state($1, '{}', $2) as s", [org, ids])).s.payments.map((p) => [
          p.id,
          Number(p.credit),
        ]),
      ),
    );

  const column = (u: U, table: "contacts" | "companies", id: string) =>
    run(u, async (q) => {
      const r = await one<{ c: string | null; h: boolean }>(q, `select public.credit_balance(t) as c, public.has_credit(t) as h from public.${table} t where t.id = $1`, [id]);
      return { c: r.c === null ? null : Number(r.c), h: r.h };
    });
  const FEATURES = { documents: true, payments: true, orders: true, quotes: true };

  beforeAll(async () => {
    owner = await createUser("cr-owner");
    org = await createOrg(owner.id, "עסק היתרות");
    manager = await addMember(org, owner.id, "manager", "cr-manager");
    member = await addMember(org, owner.id, "member", "cr-member");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, prices_include_vat) values ($1, 'licensed', false)
         on conflict (organization_id) do update set vat_status = 'licensed', prices_include_vat = false`,
        [org],
      ),
    );
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
  });

  it("counts the unallocated parts of the same customer's recorded and confirmed payments, oldest first, as money_allocation_state does", async () => {
    const x = await company("חברת יתרה");
    const a = await contact("אבי", x);
    const b = await contact("בתיה", x);
    const z = await contact("זיו");
    const d = await deal(b, x);
    const pA = await pay(50000, "2026-01-05", { contact: a });
    const pD = await pay(30000, "2026-02-01", { deal: d });
    const pZ = await pay(10000, "2026-01-01", { contact: z });
    const cancelled = await pay(7000, "2025-12-01", { contact: a });
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    const failed = await pay(9000, "2025-12-02", { contact: a });
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [failed]));
    // part of pA already allocated by hand
    const inv = await doc("tax_invoice", 20000, { contact: a });
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 20000)", [org, pA, inv]));

    const fromA = await credit(owner, { contact: a });
    expect(fromA).toMatchObject({ total: 60000, count: 2 });
    expect(fromA.payments.map((p) => [p.id, Number(p.credit)])).toEqual([
      [pA, 30000],
      [pD, 30000],
    ]);
    // the company card, the deal (with its contact) and a contact of the same company see the same credit
    expect((await credit(owner, { company: x })).total).toBe(60000);
    expect((await credit(owner, { deal: d, contact: b })).total).toBe(60000);
    expect((await credit(owner, { contact: b })).total).toBe(60000);
    // another customer
    expect(await credit(owner, { contact: z })).toMatchObject({ total: 10000, count: 1 });
    expect((await credit(owner, { contact: z })).payments[0].id).toBe(pZ);
    // one rule: each listed credit equals money_allocation_state's
    const state = await payCredit([pA, pD, pZ]);
    for (const p of [...fromA.payments, ...(await credit(owner, { contact: z })).payments]) expect(Number(p.credit)).toBe(state.get(p.id));
    // nothing named: nothing
    expect(await credit(owner, {})).toMatchObject({ total: 0, count: 0, payments: [] });
  });

  it("applies the credit to a new invoice oldest payment first, up to its balance or a cap; a release gives it back", async () => {
    const x = await company("חברת קיזוז");
    const a = await contact("אלה", x);
    const d = await deal(a, x);
    const old = await pay(40000, "2026-03-01", { contact: a });
    const later = await pay(50000, "2026-04-01", { deal: d });
    const invoice = await doc("tax_invoice", 60000, { deal: d, contact: a });
    const applied = await apply(manager, invoice);
    expect(Number(applied.allocated)).toBe(60000);
    expect(applied.payments.map((p) => [p.payment_id, Number(p.amount)])).toEqual([
      [old, 40000],
      [later, 20000],
    ]);
    expect(await docState(invoice)).toMatchObject({ paid: 60000, balance: 0, state: "paid" });
    expect((await credit(owner, { contact: a })).total).toBe(30000);
    // a paid invoice, a receipt, a document the caller may not use: nothing more
    expect(Number((await apply(manager, invoice)).allocated)).toBe(0);
    const receipt = await doc("receipt", 1000, { contact: a });
    expect(await apply(manager, receipt)).toEqual({ allocated: 0, payments: [] });
    // a cap
    const proforma = await doc("proforma", 25000, { contact: a });
    expect(Number((await apply(owner, proforma, 5000)).allocated)).toBe(5000);
    expect(await docState(proforma)).toMatchObject({ paid: 5000, balance: 20000, state: "partial" });
    expect((await pgError(apply(owner, proforma, 0))).hint).toBe("credit:max");
    // cancelling the invoice releases its allocations: the credit comes back
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [invoice]));
    expect((await credit(owner, { contact: a })).total).toBe(85000);
  });

  it("follows RLS and the allocation rights: a member counts only what they read and cannot apply; an outsider gets nothing", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const mine = await contact("של החבר", null, member.id);
      const x = await company("חברה משותפת");
      const theirs = await contact("של הבעלים", x);
      await run(owner, (q) => q("update public.contacts set company_id = $2 where id = $1", [mine, x]));
      await pay(1000, "2026-05-01", { contact: mine });
      await pay(2000, "2026-05-02", { contact: theirs });
      expect((await credit(owner, { contact: mine })).total).toBe(3000);
      // the member reads their own contact's payment only
      expect((await credit(member, { contact: mine })).total).toBe(1000);
      // the list column is for owners and admins, who read every payment
      expect(await column(member, "contacts", mine)).toEqual({ c: null, h: false });
      expect((await column(owner, "contacts", mine)).c).toBe(3000);
      const invoice = await doc("tax_invoice", 3000, { contact: mine });
      // a member does not record payments: the insert is refused and the refusal is not swallowed
      expect((await pgError(apply(member, invoice))).code).toBe("42501");
      const outsider = await createUser("cr-outsider");
      await createOrg(outsider.id, "עסק זר");
      expect(await run(outsider, async (q) => (await one<{ c: Credit }>(q, "select public.money_customer_credit($1, null, $2, null) as c", [org, mine])).c)).toMatchObject({
        total: 0,
        count: 0,
      });
      expect(await run(outsider, async (q) => (await one<{ a: Applied }>(q, "select public.money_apply_credit($1, $2) as a", [org, invoice])).a)).toEqual({ allocated: 0, payments: [] });
      expect(await asAdmin(async (q) => (await q("select 1 from public.payment_allocations where document_id = $1", [invoice])).rowCount)).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("without the documents key nothing is applied, and the refusal is raised", async () => {
    const a = await contact("בלי מסמכים");
    await pay(1000, "2026-06-01", { contact: a });
    const invoice = await doc("tax_invoice", 1000, { contact: a });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: false, payments: true })]));
    try {
      expect((await pgError(apply(owner, invoice))).hint).toBe("feature:documents");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
  });

  const sentQuote = async (on: { deal: string | null; contact: string | null }) => {
    const id = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id, valid_until) values ($1, 'הצעה', $2, $3, current_date + 14) returning id", [org, on.deal, on.contact])).id,
    );
    await run(owner, (q) => q("insert into public.quote_lines (organization_id, quote_id, position, name, unit_price_agorot) values ($1, $2, 0, 'עבודה', 10000)", [org, id]));
    await run(owner, (q) => q("select public.quote_send($1, $2)", [org, id]));
    return id;
  };
  const order = async (contactId: string, confirm = true) => {
    const id = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.orders (organization_id, contact_id) values ($1, $2) returning id", [org, contactId])).id);
    await run(owner, (q) => q("insert into public.order_lines (organization_id, order_id, name, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [org, id]));
    if (confirm) await run(owner, (q) => q("select public.order_confirm($1, $2)", [org, id]));
    return id;
  };
  const advance = (u: U, amount: number, paidOn: string, on: { deal?: string | null; contact?: string | null }, link: { quote?: string | null; order?: string | null; mark?: boolean } = {}) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method, is_advance, advance_quote_id, advance_order_id)
           values ($1, $2, $3, $4, $5, 'transfer', $6, $7, $8) returning id`,
          [org, on.deal ?? null, on.contact ?? null, amount, paidOn, link.mark ?? true, link.quote ?? null, link.order ?? null],
        )
      ).id,
    );

  it("an advance: an optional mark with one optional link to a sent quote or a numbered order of the same customer", async () => {
    const x = await company("חברת מקדמות");
    const a = await contact("עמית", x);
    const b = await contact("ברק", x);
    const z = await contact("זהבה");
    const d = await deal(a, x);
    const quote = await sentQuote({ deal: d, contact: a });
    const numbered = await order(a);
    const draft = await order(a, false);
    const elsewhere = await order(z);
    // the mark alone; a quote of the same company's other contact; an order of the contact
    await advance(manager, 1000, "2026-08-01", { contact: a });
    await advance(manager, 1000, "2026-08-01", { contact: b }, { quote });
    const linked = await advance(manager, 1000, "2026-08-01", { contact: a }, { order: numbered });
    // another customer, a draft, a link without the mark, both links
    expect((await pgError(advance(manager, 1000, "2026-08-01", { contact: a }, { order: elsewhere }))).hint).toBe("payment:advance_link");
    expect((await pgError(advance(manager, 1000, "2026-08-01", { contact: a }, { order: draft }))).hint).toBe("payment:advance_link");
    expect((await pgError(advance(manager, 1000, "2026-08-01", { contact: a }, { order: numbered, mark: false }))).code).toBe("23514");
    expect((await pgError(advance(manager, 1000, "2026-08-01", { contact: a }, { order: numbered, quote }))).code).toBe("23514");
    // an advance is still credit
    expect((await credit(owner, { contact: a })).payments.find((p) => p.id === linked)).toMatchObject({ is_advance: true, advance_order_id: numbered });
    // after the insert: owners and admins only; never on a cancelled payment
    expect((await pgError(run(manager, (q) => q("update public.payments set is_advance = false, advance_order_id = null where id = $1", [linked])))).hint).toBe("payment:correction");
    await run(owner, (q) => q("update public.payments set advance_order_id = null where id = $1", [linked]));
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [linked]));
    expect((await pgError(run(owner, (q) => q("update public.payments set is_advance = false where id = $1", [linked])))).hint).toBe("payment:cancelled");
  });

  it("offsetting offers first the advances of the document's order (or of the quote it was made from), then the oldest", async () => {
    const a = await contact("אורית");
    const d = await deal(a, null);
    const numbered = await order(a);
    const oldest = await pay(5000, "2026-01-01", { contact: a });
    const forOrder = await advance(owner, 5000, "2026-09-01", { contact: a }, { order: numbered });
    const invoice = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, order_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, 5000) returning id",
          [org, a, numbered, `CR-${++n}`],
        )
      ).id,
    );
    const applied = await apply(owner, invoice);
    expect(applied.payments.map((p) => [p.payment_id, Number(p.amount)])).toEqual([[forOrder, 5000]]);
    // an advance on the quote the order was made from counts as the order's
    const quote = await sentQuote({ deal: d, contact: a });
    await asAdmin((q) => q("update public.quotes set status = 'accepted' where id = $1", [quote]));
    const fromQuote = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.order_from_quote($1, $2) as id", [org, quote])).id);
    const forQuote = await advance(owner, 2000, "2026-09-02", { deal: d, contact: a }, { quote });
    const invoice2 = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, order_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, 'tax_invoice', $5, 3000) returning id",
          [org, d, a, fromQuote, `CR-${++n}`],
        )
      ).id,
    );
    expect((await apply(owner, invoice2)).payments.map((p) => [p.payment_id, Number(p.amount)])).toEqual([
      [forQuote, 2000],
      [oldest, 1000],
    ]);
  });

  it("the list column and filter equal the cards' credit for owners and admins, and answer null / false to anyone else", async () => {
    const x = await company("חברת עמודה");
    const a = await contact("עמודה א", x);
    const b = await contact("עמודה ב", x);
    const z = await contact("עמודה ז");
    const d = await deal(null, x);
    await pay(4000, "2026-02-01", { contact: a });
    // a payment on the company's deal and its contact counts once
    await pay(3000, "2026-02-02", { deal: d, contact: b });
    await pay(2000, "2026-02-03", { deal: d });
    await pay(1500, "2026-02-04", { contact: z });
    for (const id of [a, b]) {
      expect(await column(owner, "contacts", id)).toEqual({ c: (await credit(owner, { contact: id })).total, h: true });
    }
    expect((await column(owner, "contacts", a)).c).toBe(9000);
    expect(await column(owner, "companies", x)).toEqual({ c: (await credit(owner, { company: x })).total, h: true });
    expect(await column(owner, "contacts", z)).toEqual({ c: 1500, h: true });
    const none = await contact("בלי יתרה");
    expect(await column(owner, "contacts", none)).toEqual({ c: 0, h: false });
    // sorted and filtered by the computed fields, as the lists do
    const ordered = await run(owner, async (q) =>
      (await q<{ id: string }>("select t.id from public.contacts t where t.organization_id = $1 and t.id = any($2) order by public.credit_balance(t) desc nulls last, t.id", [org, [z, a, none]])).rows.map((r) => r.id),
    );
    expect(ordered).toEqual([a, z, none]);
    // a manager reads these records and their payments, but the totals are for owners and admins
    expect(await column(manager, "contacts", a)).toEqual({ c: null, h: false });
    expect(await column(manager, "companies", x)).toEqual({ c: null, h: false });
  });

  it("the server's company rows follow payments, allocations and company changes; the column stays equal to the card", async () => {
    const x = await company("חברת מעקב א");
    const y = await company("חברת מעקב ב");
    const a = await contact("מעקב", x);
    const d = await deal(null, x);
    const both = async () => ({ x: (await column(owner, "companies", x)).c, y: (await column(owner, "companies", y)).c });
    const equalToCards = async () => {
      for (const id of [x, y]) expect((await column(owner, "companies", id)).c).toBe((await credit(owner, { company: id })).total);
      expect((await column(owner, "contacts", a)).c).toBe((await credit(owner, { contact: a })).total);
    };
    const onContact = await pay(5000, "2026-03-01", { contact: a });
    expect(await both()).toEqual({ x: 5000, y: 0 });
    await run(owner, (q) => q("update public.contacts set company_id = $2 where id = $1", [a, y]));
    expect(await both()).toEqual({ x: 0, y: 5000 });
    const onDeal = await pay(3000, "2026-03-02", { deal: d });
    expect(await both()).toEqual({ x: 3000, y: 5000 });
    await run(owner, (q) => q("update public.deals set company_id = $2 where id = $1", [d, y]));
    expect(await both()).toEqual({ x: 0, y: 8000 });
    await equalToCards();
    const invoice = await doc("tax_invoice", 2000, { contact: a });
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 2000)", [org, onContact, invoice]));
    expect(await both()).toEqual({ x: 0, y: 6000 });
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [onDeal]));
    expect(await both()).toEqual({ x: 0, y: 3000 });
    // cancelling the invoice releases its allocation
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [invoice]));
    expect(await both()).toEqual({ x: 0, y: 5000 });
    await equalToCards();
    // nobody writes the rows but the server
    for (const sql of [
      "update public.payment_credit_companies set credit_agorot = 1 where organization_id = $1",
      "delete from public.payment_credit_companies where organization_id = $1",
      "update public.customer_credit_totals set credit_agorot = 1 where organization_id = $1",
      "delete from public.customer_credit_totals where organization_id = $1",
    ]) {
      expect((await pgError(run(owner, (q) => q(sql, [org])))).code).toBe("42501");
    }
  });

  const allocate = (q: Query, payment: string, document: string, amount: number) =>
    q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, payment, document, amount]);
  const companyTotal = (q: Query, id: string) =>
    one<{ c: string }>(q, "select credit_agorot as c from public.customer_credit_totals where organization_id = $1 and company_id = $2", [org, id]);

  it("the totals are refreshed once at commit: several changes of one company in one transaction leave the right total", async () => {
    const x = await company("חברת עסקה אחת");
    const a = await contact("עסקה א", x);
    const b = await contact("עסקה ב", x);
    const p1 = await pay(5000, "2026-08-01", { contact: a });
    const p2 = await pay(4000, "2026-08-02", { contact: b });
    const d1 = await doc("tax_invoice", 2000, { contact: a });
    const d3 = await doc("tax_invoice", 1500, { contact: a });
    expect((await column(owner, "companies", x)).c).toBe(9000);
    const inside = await run(owner, async (q) => {
      await allocate(q, p1, d1, 2000);
      await allocate(q, p2, d3, 1500);
      await q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 700, '2026-08-03', 'cash')", [org, b]);
      // deferred: inside the writing transaction the shared total still shows the state before it
      return Number((await companyTotal(q, x)).c);
    });
    expect(inside).toBe(9000);
    expect((await column(owner, "companies", x)).c).toBe(3000 + 2500 + 700);
    for (const id of [a, b]) expect((await column(owner, "contacts", id)).c).toBe((await credit(owner, { contact: id })).total);
    expect((await column(owner, "companies", x)).c).toBe((await credit(owner, { company: x })).total);
  });

  it("two allocations of one company in two transactions wait for each other instead of deadlocking", async () => {
    const x = await company("חברת נעילה");
    const a = await contact("נעילה א", x);
    const b = await contact("נעילה ב", x);
    const p1 = await pay(5000, "2026-09-01", { contact: a });
    const p2 = await pay(4000, "2026-09-02", { contact: b });
    const d1 = await doc("tax_invoice", 2000, { contact: a });
    const d2 = await doc("tax_invoice", 1000, { contact: b });
    const d3 = await doc("tax_invoice", 1500, { contact: a });

    const pids: { t1?: number; t2?: number } = {};
    const waitsOnLock = async (pid: number | undefined) =>
      pid !== undefined &&
      (await asAdmin(async (q) => (await q("select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'", [pid])).rowCount)) === 1;
    const until = async (cond: () => Promise<boolean> | boolean) => {
      for (let i = 0; i < 400; i++) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timed out waiting");
    };
    let t1First = false;
    let t2First = false;
    // T1: P1 -> D1, then (after T2 holds P2) P2 -> D3. T2: P2 -> D2, kept open until T1 waits on P2.
    // Before the totals were deferred, T1 held the company's total after its first insert, T2 waited for it while holding
    // P2, and T1's second insert waited for P2: 40P01.
    const t1 = run(owner, async (q) => {
      pids.t1 = Number((await one<{ p: number }>(q, "select pg_backend_pid() as p")).p);
      await allocate(q, p1, d1, 2000);
      t1First = true;
      await until(async () => t2First || (await waitsOnLock(pids.t2)));
      await allocate(q, p2, d3, 1500);
    });
    const t2 = run(owner, async (q) => {
      pids.t2 = Number((await one<{ p: number }>(q, "select pg_backend_pid() as p")).p);
      await until(() => t1First);
      await allocate(q, p2, d2, 1000);
      t2First = true;
      await until(() => waitsOnLock(pids.t1));
    });
    const results = await Promise.allSettled([t1, t2]);
    expect(results.map((r) => (r.status === "rejected" ? (r.reason as { code?: string }).code ?? String(r.reason) : "ok"))).toEqual(["ok", "ok"]);
    expect((await column(owner, "companies", x)).c).toBe(3000 + 1500);
    expect((await column(owner, "companies", x)).c).toBe((await credit(owner, { company: x })).total);
  });

  it("the sync triggers are deferred constraint triggers, and the migration refuses plain ones left by an earlier draft", async () => {
    const triggers = await asAdmin(async (q) =>
      (
        await q<{ name: string; deferred: boolean }>(
          `select tgname as name, (tgconstraint <> 0 and tgdeferrable and tginitdeferred) as deferred from pg_trigger
            where not tgisinternal and tgname in ('payments_credit_companies', 'payment_allocations_credit_companies', 'contacts_credit_companies', 'deals_credit_companies')
            order by tgname`,
        )
      ).rows,
    );
    expect(triggers).toEqual(
      ["contacts_credit_companies", "deals_credit_companies", "payment_allocations_credit_companies", "payments_credit_companies"].map((name) => ({ name, deferred: true })),
    );
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_credit_advances_list.sql"))!;
    const sql = readFileSync(path.join(dir, file), "utf8");
    // inside a transaction that is rolled back: the old draft's plain trigger
    const error = await pgError(
      asAdmin(async (q) => {
        await q("drop trigger payments_credit_companies on public.payments");
        await q("create trigger payments_credit_companies after insert or update on public.payments for each row execute function app.payment_credit_companies_on_payment()");
        await q(sql);
      }),
    );
    expect(error.code).toBe("55000");
    expect(error.message).toContain("payments_credit_companies");
    expect(await asAdmin(async (q) => (await q("select 1 from pg_trigger where tgname = 'payments_credit_companies' and tginitdeferred")).rowCount)).toBe(1);
  });

  it("a race refusal skips that payment (payment_over, payment_state) or re-reads the document (document_over); any other refusal is raised", async () => {
    const a = await contact("מרוץ");
    const first = await pay(1000, "2026-07-01", { contact: a });
    const second = await pay(1000, "2026-07-02", { contact: a });
    const invoice = await doc("tax_invoice", 1500, { contact: a });
    class Rollback extends Error {}
    // a temporary trigger (rolled back with its transaction) refuses the allocation of one payment with the given hint
    const raced = async (payment: string, hint: string) => {
      let out: Applied | { error: { hint?: string; code?: string } } | null = null;
      await asAdmin(async (q) => {
        await q(
          `create function pg_temp.race() returns trigger language plpgsql as $f$
           begin
             if new.payment_id = current_setting('test.race_payment')::uuid then
               raise exception 'race' using errcode = 'P0001', hint = current_setting('test.race_hint');
             end if;
             return new;
           end $f$`,
        );
        await q("create trigger zz_race before insert on public.payment_allocations for each row execute function pg_temp.race()");
        await q("select set_config('test.race_payment', $1, true), set_config('test.race_hint', $2, true)", [payment, hint]);
        await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: owner.id, role: "authenticated" })]);
        await q("set local role authenticated");
        await q("savepoint s");
        try {
          out = (await one<{ a: Applied }>(q, "select public.money_apply_credit($1, $2) as a", [org, invoice])).a;
        } catch (error) {
          out = { error: error as { hint?: string; code?: string } };
          await q("rollback to savepoint s");
        }
        throw new Rollback();
      }).catch((error) => {
        if (!(error instanceof Rollback)) throw error;
      });
      return out!;
    };
    for (const hint of ["allocation:payment_over", "allocation:payment_state"]) {
      const result = (await raced(first, hint)) as Applied;
      expect(result.payments.map((p) => [p.payment_id, Number(p.amount)])).toEqual([[second, 1000]]);
    }
    // document_over: the balance is read again (still 1,500 here), and the next payment takes it
    const reread = (await raced(first, "allocation:document_over")) as Applied;
    expect(reread.payments.map((p) => p.payment_id)).toEqual([second]);
    // anything else is raised
    const other = (await raced(first, "allocation:customer")) as { error: { hint?: string } };
    expect(other.error.hint).toBe("allocation:customer");
    // everything was rolled back
    expect(await asAdmin(async (q) => (await q("select 1 from public.payment_allocations where document_id = $1", [invoice])).rowCount)).toBe(0);
    expect(await asAdmin(async (q) => (await q("select 1 from pg_trigger where tgname = 'zz_race'")).rowCount)).toBe(0);
  });
});

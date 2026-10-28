import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DOCUMENT_PAYMENT_STATES } from "@/features/allocations/state";
import { documentPayState } from "@/features/documents/pay-state";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * DOC-03: the documents list by payment state (open, partly paid, paid, overdue, cancelled; plus transferred and none) and by
 * customer, through public.documents_by_pay_state (invoker: RLS decides), with app.document_pay_state = documentPayState().
 */
describe("documents by payment state and customer (DOC-03)", () => {
  let owner: U, member: U, outsider: U;
  let org: string;
  let today: string;
  const docs: Record<string, string> = {};
  let contactA: string, contactB: string, dealB: string, company: string, contactC: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  let seq = 0;
  const record = (fields: { contact?: string | null; deal?: string | null; type?: string; amount?: number; due?: string | null; proforma?: string | null }) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, deal_id, doc_type, number, amount_agorot, due_date, proforma_id, doc_date) values ($1, $2, $3, $4, $5, $6, $7, $8, current_date - 10) returning id",
          [org, fields.contact ?? null, fields.deal ?? null, fields.type ?? "tax_invoice", `PS-${++seq}`, fields.amount ?? 1000, fields.due ?? null, fields.proforma ?? null],
        )
      ).id,
    );
  const pay = (contact: string, document: string, amount: number) =>
    asUser(owner.id, async (q) => {
      const payment = (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, $3, 'cash') returning id", [org, contact, amount])).id;
      await q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, payment, document, amount]);
    });
  const listed = (u: U, states: string[] | null, contact: string | null = null, companyId: string | null = null, orgId = org) =>
    asUser(u.id, async (q) =>
      (await q<{ id: string }>("select id from public.documents_by_pay_state($1, $2, $3, $4) order by id", [orgId, states, contact, companyId])).rows.map((r) => r.id).sort(),
    );
  const ids = (...keys: string[]) => keys.map((k) => docs[k]).sort();

  beforeAll(async () => {
    owner = await createUser("ps-owner");
    org = await createOrg(owner.id, "עסק מצבי תשלום");
    member = await addMember(org, owner.id, "member", "ps-member");
    outsider = await createUser("ps-outsider");
    await createOrg(outsider.id, "עסק זר");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = '{\"documents\": true, \"payments\": true}' where organization_id = $1", [org]),
    );
    // a business far west of Israel: its today is not Israel's for part of every day
    await asAdmin((q) => q("update public.organizations set timezone = 'Pacific/Pago_Pago' where id = $1", [org]));
    // own visibility: a member reads only their own records
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    today = await asAdmin(async (q) => (await one<{ d: string }>(q, "select ((now() at time zone 'Pacific/Pago_Pago')::date)::text as d")).d);
    const yesterday = await asAdmin(async (q) => (await one<{ d: string }>(q, "select ((now() at time zone 'Pacific/Pago_Pago')::date - 1)::text as d")).d);
    const pipe = await defaultPipeline(org);
    await asUser(owner.id, async (q) => {
      contactA = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'א', $2) returning id", [org, owner.id])).id;
      contactB = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'ב', $2) returning id", [org, owner.id])).id;
      company = (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברה', $2) returning id", [org, owner.id])).id;
      contactC = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, 'ג', $2, $3) returning id", [org, owner.id, company])).id;
      dealB = (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
          [org, pipe.pipelineId, pipe.stages.find((s) => s.kind === "open")!.id, contactB, owner.id],
        )
      ).id;
    });
    docs.open = await record({ contact: contactA, due: today });
    docs.noDue = await record({ contact: contactA });
    docs.overdue = await record({ contact: contactA, due: yesterday });
    docs.partial = await record({ contact: contactA, due: today });
    await pay(contactA, docs.partial, 400);
    docs.partialLate = await record({ contact: contactA, due: yesterday });
    await pay(contactA, docs.partialLate, 400);
    docs.paid = await record({ contact: contactA, due: yesterday });
    await pay(contactA, docs.paid, 1000);
    docs.receiptInvoice = await record({ contact: contactA, type: "tax_invoice_receipt" });
    docs.receipt = await record({ contact: contactA, type: "receipt" });
    docs.cancelled = await record({ contact: contactA, due: yesterday });
    await asUser(owner.id, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [docs.cancelled]));
    docs.proforma = await record({ contact: contactA, type: "proforma" });
    docs.billing = await record({ contact: contactA, proforma: docs.proforma });
    // customers: a document on contact B's deal (no contact on it), and one on the company's contact
    docs.onDeal = await record({ deal: dealB });
    docs.onCompany = await record({ contact: contactC });
  });

  it("app.document_pay_state is documentPayState(), case by case", async () => {
    const cases: [string, string | null, string | null, string][] = [];
    for (const status of ["active", "cancelled"]) {
      for (const state of [...DOCUMENT_PAYMENT_STATES, null]) {
        for (const due of [null, "2026-01-09", "2026-01-10", "2026-01-11"]) cases.push([status, state, due, "2026-01-10"]);
      }
    }
    const sql = await asAdmin(async (q) =>
      (
        await q<{ s: string }>(
          "select app.document_pay_state(c ->> 0, c ->> 1, (c ->> 2)::date, (c ->> 3)::date) as s from jsonb_array_elements($1::jsonb) with ordinality as x(c, n) order by n",
          [JSON.stringify(cases)],
        )
      ).rows.map((r) => r.s),
    );
    expect(sql).toEqual(cases.map(([status, state, due, day]) => documentPayState(status === "cancelled", state as never, due, day)));
  });

  it("each state finds its documents; overdue is judged in the business's time zone", async () => {
    expect(await listed(owner, ["open"])).toEqual(ids("open", "noDue", "billing", "onDeal", "onCompany"));
    expect(await listed(owner, ["partial"])).toEqual(ids("partial"));
    expect(await listed(owner, ["overdue"])).toEqual(ids("overdue", "partialLate"));
    expect(await listed(owner, ["paid"])).toEqual(ids("paid", "receiptInvoice"));
    expect(await listed(owner, ["cancelled"])).toEqual(ids("cancelled"));
    expect(await listed(owner, ["transferred"])).toEqual(ids("proforma"));
    expect(await listed(owner, ["none"])).toEqual(ids("receipt"));
    expect(await listed(owner, ["open", "overdue"])).toEqual(ids("open", "noDue", "billing", "onDeal", "onCompany", "overdue", "partialLate"));
    // no state asked: every document
    expect(await listed(owner, null)).toEqual(Object.values(docs).sort());
  });

  it("a customer: a contact's own documents and its deals'; a company's, its contacts' and its deals'", async () => {
    expect(await listed(owner, null, contactB)).toEqual(ids("onDeal"));
    expect(await listed(owner, null, null, company)).toEqual(ids("onCompany"));
    expect(await listed(owner, ["open"], contactA)).toEqual(ids("open", "noDue", "billing"));
    // a deal of the company counts too
    await asAdmin((q) => q("update public.deals set company_id = $2 where id = $1", [dealB, company]));
    try {
      expect(await listed(owner, null, null, company)).toEqual(ids("onDeal", "onCompany"));
    } finally {
      await asAdmin((q) => q("update public.deals set company_id = null where id = $1", [dealB]));
    }
  });

  it("RLS decides: a member who reads none of these records and an outsider get nothing", async () => {
    expect(await listed(member, null)).toEqual([]);
    expect(await listed(member, ["open"])).toEqual([]);
    expect(await listed(outsider, null)).toEqual([]);
    expect(await listed(outsider, ["open"], contactA)).toEqual([]);
  });

  type Summary = { count: number; by_type: Record<string, { count: number; agorot: number }>; partial: boolean; open: number | null; overdue: number | null };
  const summary = (u: U, args: { states?: string[] | null; contact?: string | null; type?: string | null; ids?: string[] | null } = {}) =>
    asUser(u.id, async (q) =>
      (
        await one<{ s: Summary }>(q, "select public.documents_pay_summary($1, $2, $3, null, $4, null, null, null, $5) as s", [
          org,
          args.states ?? null,
          args.contact ?? null,
          args.type ?? null,
          args.ids ?? null,
        ])
      ).s,
    );

  it("the summary line: documents in force, per type, the open balance and its overdue part, in one call", async () => {
    expect(await summary(owner)).toEqual({
      count: 12,
      by_type: {
        tax_invoice: { count: 9, agorot: 9000 },
        tax_invoice_receipt: { count: 1, agorot: 1000 },
        receipt: { count: 1, agorot: 1000 },
        proforma: { count: 1, agorot: 1000 },
      },
      partial: false,
      open: 7200,
      overdue: 1600,
    });
    expect(await summary(owner, { states: ["overdue"] })).toMatchObject({ count: 2, open: 1600, overdue: 1600 });
    expect(await summary(owner, { states: ["cancelled"] })).toMatchObject({ count: 0, open: 0 });
    expect(await summary(owner, { contact: contactB })).toMatchObject({ count: 1, open: 1000, overdue: 0 });
    expect(await summary(owner, { type: "receipt" })).toMatchObject({ count: 1, open: 0 });
    // the rows the list's advanced filter found
    expect(await summary(owner, { ids: [docs.partial, docs.paid, docs.cancelled] })).toMatchObject({ count: 2, open: 600, overdue: 0 });
  });

  it("COL-01's partial rule: no balance totals for whoever does not read every money row", async () => {
    expect(await summary(member)).toEqual({ count: 0, by_type: {}, partial: true, open: null, overdue: null });
    // an outsider reads nothing of this business
    expect(await summary(outsider)).toMatchObject({ count: 0, open: null });
    // and learns nothing about the business's plan: the same answer whether it has the payments key or not
    expect(await summary(outsider)).toEqual({ count: 0, by_type: {}, partial: false, open: null, overdue: null });
  });

  it("the summary refuses more than 20,000 ids; an empty state list finds nothing", async () => {
    const many = Array.from({ length: 20_001 }, () => docs.paid);
    const error = await summary(owner, { ids: many }).catch((e: { hint?: string }) => e);
    expect((error as { hint?: string }).hint).toBe("documents_pay:too_many");
    expect(await listed(owner, [])).toEqual([]);
    expect(await summary(owner, { states: [] })).toMatchObject({ count: 0, open: 0 });
  });

  it("the page's rows: one call with each document's state and open balance", async () => {
    const rows = await asUser(owner.id, async (q) =>
      (await one<{ r: { id: string; pay_state: string; balance: number | null }[] }>(q, "select public.documents_pay_rows($1, $2) as r", [org, [docs.partialLate, docs.paid, docs.cancelled, docs.proforma]])).r,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, [r.pay_state, r.balance]]));
    expect(byId).toEqual({
      [docs.partialLate]: ["overdue", 600],
      [docs.paid]: ["paid", null],
      [docs.cancelled]: ["cancelled", null],
      [docs.proforma]: ["transferred", null],
    });
    const many = Array.from({ length: 2001 }, () => docs.paid);
    const error = await asUser(owner.id, (q) => q("select public.documents_pay_rows($1, $2)", [org, many])).catch((e: { hint?: string }) => e);
    expect((error as { hint?: string }).hint).toBe("documents_pay:too_many");
  });

  it("PostgREST filters the set like the table (type, date, order)", async () => {
    const rows = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          "select id from public.documents_by_pay_state($1, array['open'], null, null) where doc_type = 'tax_invoice' and contact_id = $2 order by doc_date desc, id",
          [org, contactA],
        )
      ).rows.map((r) => r.id).sort(),
    );
    expect(rows).toEqual(ids("open", "noDue", "billing"));
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type DocState = { id: string; paid: number; balance: number; state: string; invoice_number: string | null };
type PayState = { id: string; allocated: number; credit: number };

/**
 * PAY-02: a payment is allocated, wholly or in parts, to tax invoices and proformas of the same customer; the document's
 * balance and state follow, and so does the payment's credit. Releases are final; a proforma billed by a tax invoice hands
 * its payments to the invoice.
 */
describe("allocating payments to documents (PAY-02)", () => {
  let owner: U, admin: U, manager: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const company = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const contact = (name: string, companyId: string | null = null) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, owner.id])).id,
    );
  const deal = (contactId: string | null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id", [
          org,
          pipelineId,
          stageId,
          contactId,
          owner.id,
        ])
      ).id,
    );
  const doc = (type: string, amount: number, on: { deal?: string | null; contact?: string | null; proforma?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, proforma_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, on.deal ?? null, on.contact ?? null, on.proforma ?? null, type, `AL-${++n}`, amount],
        )
      ).id,
    );
  const pay = (amount: number, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method) values ($1, $2, $3, $4, 'transfer') returning id", [
          org,
          on.deal ?? null,
          on.contact ?? null,
          amount,
        ])
      ).id,
    );
  const allocate = (u: U, payment: string, document: string, amount: number) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4) returning id", [
          org,
          payment,
          document,
          amount,
        ])
      ).id,
    );
  const state = async (u: U, documents: string[], payments: string[] = []) => {
    const out = await run(u, async (q) => (await one<{ s: { documents: DocState[]; payments: PayState[] } }>(q, "select public.money_allocation_state($1, $2, $3) as s", [org, documents, payments])).s);
    return { docs: new Map(out.documents.map((d) => [d.id, d])), pays: new Map(out.payments.map((p) => [p.id, p])) };
  };
  const docState = async (id: string) => (await state(owner, [id])).docs.get(id)!;
  const payState = async (id: string) => (await state(owner, [], [id])).pays.get(id)!;

  beforeAll(async () => {
    owner = await createUser("al-owner");
    org = await createOrg(owner.id, "עסק השיוכים");
    admin = await addMember(org, owner.id, "admin", "al-admin");
    manager = await addMember(org, owner.id, "manager", "al-manager");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true })]));
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

  it("a partial and then a full payment move the invoice from unpaid to partly paid to paid; the rest of a payment is credit", async () => {
    const c = await contact("רון");
    const d = await deal(c);
    const invoice = await doc("tax_invoice", 10000, { deal: d, contact: c });
    expect(await docState(invoice)).toMatchObject({ paid: 0, balance: 10000, state: "unpaid" });
    const first = await pay(4000, { deal: d });
    await allocate(owner, first, invoice, 4000);
    expect(await docState(invoice)).toMatchObject({ paid: 4000, balance: 6000, state: "partial" });
    expect(await payState(first)).toMatchObject({ allocated: 4000, credit: 0 });
    const second = await pay(8000, { contact: c });
    await allocate(manager, second, invoice, 6000);
    expect(await docState(invoice)).toMatchObject({ paid: 10000, balance: 0, state: "paid" });
    expect(await payState(second)).toMatchObject({ allocated: 6000, credit: 2000 });
    // nothing more than either holds
    expect((await pgError(allocate(owner, second, invoice, 1))).hint).toBe("allocation:document_over");
    const other = await doc("proforma", 50000, { contact: c });
    expect((await pgError(allocate(owner, second, other, 2001))).hint).toBe("allocation:payment_over");
    await allocate(owner, second, other, 2000);
    expect(await payState(second)).toMatchObject({ allocated: 8000, credit: 0 });
    // a correction never leaves a payment below what it allocated
    expect((await pgError(run(owner, (q) => q("update public.payments set amount_agorot = 7000 where id = $1", [second])))).hint).toBe("payment:allocated");
  });

  it("only a tax invoice or a proforma of the same customer takes a recorded or confirmed payment", async () => {
    const acme = await company("אקמי");
    const a1 = await contact("א1", acme);
    const a2 = await contact("א2", acme);
    const stranger = await contact("זר");
    const payment = await pay(5000, { contact: a1 });
    // the contact's company counts as the same customer
    const atCompany = await doc("tax_invoice", 1000, { contact: a2 });
    await allocate(owner, payment, atCompany, 100);
    // a deal of the company too
    const companyDeal = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, company_id) values ($1, 'חברה', $2, $3, $4) returning id", [org, pipelineId, stageId, acme])).id,
    );
    const companyProforma = await doc("proforma", 1000, { deal: companyDeal });
    await allocate(owner, payment, companyProforma, 100);
    const strangerInvoice = await doc("tax_invoice", 1000, { contact: stranger });
    expect((await pgError(allocate(owner, payment, strangerInvoice, 100))).hint).toBe("allocation:customer");
    // the window offers what the trigger accepts: the same customer's open documents with a balance, and back
    type Candidates = { documents: { id: string; balance: number }[]; payments: { id: string; credit: number }[] };
    const candidates = (paymentId: string | null, documentId: string | null) =>
      run(owner, async (q) => (await one<{ c: Candidates }>(q, "select public.money_allocation_candidates($1, $2, $3) as c", [org, paymentId, documentId])).c);
    const forPayment = await candidates(payment, null);
    expect(forPayment.documents.map((d) => d.id).sort()).toEqual([atCompany, companyProforma].sort());
    expect(forPayment.documents.find((d) => d.id === atCompany)?.balance).toBe(900);
    expect((await candidates(null, atCompany)).payments).toEqual([expect.objectContaining({ id: payment, credit: 4800 })]);
    expect((await candidates(null, strangerInvoice)).payments).toEqual([]);
    for (const type of ["receipt", "tax_invoice_receipt", "credit_invoice"]) {
      expect((await pgError(allocate(owner, payment, await doc(type, 1000, { contact: a1 }), 100))).hint, type).toBe("allocation:doc_type");
    }
    const failed = await pay(1000, { contact: a1 });
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [failed]));
    expect((await pgError(allocate(owner, failed, atCompany, 100))).hint).toBe("allocation:payment_state");
    const cancelledDoc = await doc("tax_invoice", 1000, { contact: a1 });
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelledDoc]));
    expect((await pgError(allocate(owner, payment, cancelledDoc, 100))).hint).toBe("allocation:document_state");
    // an allocation never moves to another payment or document
    const allocation = await allocate(owner, payment, atCompany, 1);
    expect((await pgError(run(owner, (q) => q("update public.payment_allocations set amount_agorot = 0 where id = $1", [allocation])))).code).toBe("23514");
  });

  it("a failed or cancelled payment and a cancelled document release their allocations for good; the payment becomes credit", async () => {
    const c = await contact("דנה");
    const invoice = await doc("tax_invoice", 3000, { contact: c });
    const p1 = await pay(1000, { contact: c });
    const p2 = await pay(1000, { contact: c });
    await allocate(owner, p1, invoice, 1000);
    await allocate(owner, p2, invoice, 1000);
    expect(await docState(invoice)).toMatchObject({ paid: 2000, state: "partial" });
    await run(manager, (q) => q("update public.payments set status = 'failed' where id = $1", [p1]));
    expect(await docState(invoice)).toMatchObject({ paid: 1000, balance: 2000 });
    // back from failed: the release stays (the lead's call 2)
    await run(manager, (q) => q("update public.payments set status = 'recorded' where id = $1", [p1]));
    expect(await docState(invoice)).toMatchObject({ paid: 1000 });
    expect(await payState(p1)).toMatchObject({ allocated: 0, credit: 1000 });
    // the document is cancelled: the other payment returns to credit
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'הופק בטעות' where id = $1", [invoice]));
    expect(await payState(p2)).toMatchObject({ allocated: 0, credit: 1000 });
    expect(await docState(invoice)).toMatchObject({ state: "none", balance: 0 });
    const released = await asAdmin(async (q) => (await q<{ n: string }>("select count(*) as n from public.payment_allocations where document_id = $1 and released_at is not null", [invoice])).rows[0].n);
    expect(Number(released)).toBe(2);
    // a released allocation is closed, and a person never releases or revives one
    const allocation = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.payment_allocations where payment_id = $1", [p2])).id);
    expect((await pgError(run(owner, (q) => q("update public.payment_allocations set amount_agorot = 5 where id = $1", [allocation])))).hint).toBe("allocation:closed");
    expect((await pgError(run(owner, (q) => q("update public.payment_allocations set released_at = null where id = $1", [allocation])))).code).toBe("42501");
  });

  it("a status a BEFORE trigger derives (not in the statement's columns) still releases the allocations", async () => {
    const c = await contact("נגזר");
    const invoice = await doc("tax_invoice", 1000, { contact: c });
    const p = await pay(1000, { contact: c });
    await allocate(owner, p, invoice, 1000);
    // a throwaway BEFORE trigger stands in for a derived status (as PAY-04's cheque status does): the statement names
    // only the note, the trigger moves the payment to failed
    await asAdmin(async (q) => {
      await q("create function app.test_derive_failed() returns trigger language plpgsql as $f$ begin if new.note = 'נכשל' then new.status := 'failed'; end if; return new; end $f$");
      await q("create trigger payments_0_test_derive before update on public.payments for each row execute function app.test_derive_failed()");
    });
    try {
      await asAdmin((q) => q("update public.payments set note = 'נכשל' where id = $1", [p]));
      expect(await payState(p)).toMatchObject({ allocated: 0, credit: 0 });
      expect(await docState(invoice)).toMatchObject({ paid: 0, state: "unpaid" });
    } finally {
      await asAdmin(async (q) => {
        await q("drop trigger payments_0_test_derive on public.payments");
        await q("drop function app.test_derive_failed()");
      });
    }
  });

  it("owners and admins change or undo an allocation; a manager who allocated does neither", async () => {
    const c = await contact("גל");
    const invoice = await doc("tax_invoice", 5000, { contact: c });
    const p = await pay(5000, { contact: c });
    const allocation = await allocate(manager, p, invoice, 1000);
    expect(await run(manager, async (q) => (await q("update public.payment_allocations set amount_agorot = 2000 where id = $1", [allocation])).rowCount)).toBe(0);
    expect((await pgError(run(admin, (q) => q("update public.payment_allocations set amount_agorot = 6000 where id = $1", [allocation])))).hint).toBe("allocation:payment_over");
    expect(await run(admin, async (q) => (await q("update public.payment_allocations set amount_agorot = 3000 where id = $1", [allocation])).rowCount)).toBe(1);
    expect(await docState(invoice)).toMatchObject({ paid: 3000 });
    expect((await pgError(run(admin, (q) => q("update public.payment_allocations set removed_at = now(), amount_agorot = 1 where id = $1", [allocation])))).hint).toBe("allocation:closed");
    await run(admin, (q) => q("update public.payment_allocations set removed_at = now() where id = $1", [allocation]));
    const row = await asAdmin((q) => one<{ removed_by: string; amount_agorot: string }>(q, "select removed_by, amount_agorot from public.payment_allocations where id = $1", [allocation]));
    expect(row).toMatchObject({ removed_by: admin.id, amount_agorot: "3000" });
    expect(await docState(invoice)).toMatchObject({ paid: 0, state: "unpaid" });
    expect((await pgError(run(owner, (q) => q("update public.payment_allocations set removed_at = null where id = $1", [allocation])))).hint).toBe("allocation:closed");
    // audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'payment_allocations' and entity_id = $1", [allocation]))).toBeGreaterThanOrEqual(3);
  });

  it("a tax invoice bills one proforma of the same customer, once; the proforma's payments count toward the invoice", async () => {
    const c = await contact("שירה");
    const proforma = await doc("proforma", 10000, { contact: c });
    const p = await pay(4000, { contact: c });
    await allocate(owner, p, proforma, 4000);
    expect(await docState(proforma)).toMatchObject({ paid: 4000, state: "partial" });
    // linked later, by an update
    const invoice = await doc("tax_invoice", 10000, { contact: c });
    await run(owner, (q) => q("update public.accounting_documents set proforma_id = $2 where id = $1", [invoice, proforma]));
    const both = await state(owner, [proforma, invoice]);
    expect(both.docs.get(proforma)).toMatchObject({ state: "transferred", balance: 0 });
    expect(both.docs.get(invoice)).toMatchObject({ paid: 4000, balance: 6000, state: "partial" });
    // the proforma takes no more payments; the invoice counts its proforma's against its own amount
    const p2 = await pay(7000, { contact: c });
    expect((await pgError(allocate(owner, p2, proforma, 1))).hint).toBe("allocation:transferred");
    expect((await pgError(allocate(owner, p2, invoice, 6001))).hint).toBe("allocation:document_over");
    await allocate(owner, p2, invoice, 6000);
    expect(await docState(invoice)).toMatchObject({ paid: 10000, state: "paid" });
    // set once; one invoice per proforma; a proforma of another customer, or a non-proforma, is refused
    expect((await pgError(run(owner, (q) => q("update public.accounting_documents set proforma_id = null where id = $1", [invoice])))).hint).toBe("document:proforma");
    expect((await pgError(doc("tax_invoice", 1, { contact: c, proforma })))).toMatchObject({ hint: "document:proforma" });
    const stranger = await contact("זרה");
    expect((await pgError(doc("tax_invoice", 1, { contact: stranger, proforma: await doc("proforma", 1, { contact: c }) })))).toMatchObject({ hint: "document:proforma" });
    expect((await pgError(doc("tax_invoice", 1, { contact: c, proforma: await doc("tax_invoice", 1, { contact: c }) })))).toMatchObject({ hint: "document:proforma" });
    expect((await pgError(doc("receipt", 1, { contact: c, proforma: await doc("proforma", 1, { contact: c }) })))).toMatchObject({ hint: "document:proforma" });
    // the invoice is cancelled: the proforma is debt again with its own payments
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'הוחלפה' where id = $1", [invoice]));
    expect(await docState(proforma)).toMatchObject({ paid: 4000, balance: 6000, state: "partial" });
    // review of 020760: a replacement invoice bills the same proforma; the cancelled one keeps its link
    const replacement = await doc("tax_invoice", 10000, { contact: c, proforma });
    const after = await state(owner, [proforma, replacement, invoice]);
    expect(after.docs.get(proforma)).toMatchObject({ state: "transferred" });
    expect(after.docs.get(replacement)).toMatchObject({ paid: 4000, balance: 6000, state: "partial" });
    expect(await asAdmin(async (q) => (await one<{ p: string }>(q, "select proforma_id as p from public.accounting_documents where id = $1", [invoice])).p)).toBe(proforma);
    // and while the replacement is active, no third invoice bills it
    expect((await pgError(doc("tax_invoice", 1, { contact: c, proforma }))).hint).toBe("document:proforma");
  });

  it("a tax invoice/receipt is paid when recorded; a receipt and a credit invoice have no balance", async () => {
    const c = await contact("נועה");
    const ids = [await doc("tax_invoice_receipt", 1000, { contact: c }), await doc("receipt", 1000, { contact: c }), await doc("credit_invoice", 1000, { contact: c })];
    const s = await state(owner, ids);
    expect(ids.map((id) => s.docs.get(id)?.state)).toEqual(["paid_on_issue", "none", "none"]);
    expect(ids.map((id) => s.docs.get(id)?.balance)).toEqual([0, 0, 0]);
  });

  it("concurrent allocations of one payment never pass its amount", async () => {
    const c = await contact("מקביל");
    const p = await pay(1000, { contact: c });
    const docs = await Promise.all([doc("tax_invoice", 1000, { contact: c }), doc("tax_invoice", 1000, { contact: c })]);
    const results = await Promise.allSettled(docs.map((d) => allocate(owner, p, d, 700)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await payState(p)).toMatchObject({ allocated: 700, credit: 300 });
  });

  it("allocating needs both plan keys; an outsider learns nothing", async () => {
    const c = await contact("מפתחות");
    const invoice = await doc("tax_invoice", 1000, { contact: c });
    const p = await pay(1000, { contact: c });
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: false, payments: true })]));
    try {
      expect((await pgError(allocate(owner, p, invoice, 1))).hint).toBe("feature:documents");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true })]));
    }
    const outsider = await createUser("al-outsider");
    await createOrg(outsider.id, "עסק זר");
    expect((await pgError(allocate(outsider, p, invoice, 1))).code).toBe("42501");
    const seen = await asUser(outsider.id, async (q) => (await one<{ s: { documents: unknown[]; payments: unknown[] } }>(q, "select public.money_allocation_state($1, $2, $3) as s", [org, [invoice], [p]])).s);
    expect(seen).toEqual({ documents: [], payments: [] });
  });
});

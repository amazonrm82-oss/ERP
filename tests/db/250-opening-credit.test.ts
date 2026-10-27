import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * GAP-12, owner's answer (2) א (26 October 2026): a negative opening balance is customer credit, offset against the same
 * customer's invoices like a payment's credit (public.opening_credit_allocations, PAY-02's rules: never over the credit or
 * the document, the same customer, released when either is cancelled, undone only by owners and admins).
 */
describe("opening credit (GAP-12)", () => {
  let owner: U, admin: U, manager: U, member: U;
  let org: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const company = () =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, `חברה ${++n}`, owner.id])).id);
  const contact = (companyId: string | null = null) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, $2, $3, $4) returning id", [org, `לקוח ${++n}`, owner.id, companyId])).id,
    );
  const setOb = (on: { contact?: string; company?: string }, amount: number) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, $3, $4, '2026-01-01') as id", [org, on.contact ?? null, on.company ?? null, amount])).id,
    );
  const invoice = (contactId: string, amount: number, type = "tax_invoice") =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, $3, $4, '2026-02-01', $5) returning id", [
          org,
          contactId,
          type,
          `OC-${++n}`,
          amount,
        ])
      ).id,
    );
  const offset = (u: U, credit: string, document: string, amount: number) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot) values ($1, $2, $3, $4) returning id", [
          org,
          credit,
          document,
          amount,
        ])
      ).id,
    );
  const state = (id: string) =>
    run(owner, async (q) =>
      (await one<{ s: { state: string; balance: number; paid: number; credit: number } }>(q, "select public.money_allocation_state($1, array[$2]::uuid[], '{}') -> 'documents' -> 0 as s", [org, id])).s,
    );
  const apply = (document: string) =>
    run(owner, async (q) => (await one<{ r: { allocated: number; documents: { document_id: string; amount: number }[] } }>(q, "select public.money_apply_credit($1, $2) as r", [org, document])).r);

  beforeAll(async () => {
    owner = await createUser("oc-owner");
    org = await createOrg(owner.id, "עסק הזכויות");
    admin = await addMember(org, owner.id, "admin", "oc-admin");
    manager = await addMember(org, owner.id, "manager", "oc-manager");
    member = await addMember(org, owner.id, "member", "oc-member");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true, balances: true })]),
    );
  });

  it("a negative opening balance is offset against the customer's invoice (apply credit), never over either side", async () => {
    const c = await contact();
    const credit = await setOb({ contact: c }, -5000);
    expect(await state(credit)).toMatchObject({ state: "none", credit: 5000 });
    const inv = await invoice(c, 8000);
    const r = await apply(inv);
    expect(r.allocated).toBe(5000);
    expect(r.documents).toEqual([{ document_id: credit, amount: 5000 }]);
    expect(await state(inv)).toMatchObject({ state: "partial", paid: 5000, balance: 3000 });
    expect((await state(credit)).credit).toBe(0);
    // never over the credit; never over the document (a payment included)
    const inv2 = await invoice(c, 1000);
    expect((await pgError(offset(owner, credit, inv2, 1))).hint).toBe("credit_allocation:over");
    const credit2 = await setOb({ contact: await contact() }, -100);
    void credit2;
    const pay = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, method) values ($1, $2, 4000, 'cash') returning id", [org, c])).id,
    );
    expect((await pgError(run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 3001)", [org, pay, inv])))).hint).toBe(
      "allocation:document_over",
    );
  });

  it("only an active opening credit, only to a document that takes payments, only of the same customer", async () => {
    const co = await company();
    const worker = await contact(co);
    const companyCredit = await setOb({ company: co }, -2000);
    // a company's credit goes to its contact's invoice
    await offset(owner, companyCredit, await invoice(worker, 500), 500);
    // another customer's invoice: refused
    expect((await pgError(offset(owner, companyCredit, await invoice(await contact(), 500), 100))).hint).toBe("allocation:customer");
    // a receipt takes nothing; a debt is not a credit
    expect((await pgError(offset(owner, companyCredit, await invoice(worker, 500, "receipt"), 100))).hint).toBe("allocation:doc_type");
    const c = await contact();
    const debt = await setOb({ contact: c }, 900);
    expect((await pgError(offset(owner, debt, await invoice(c, 500), 100))).hint).toBe("credit_allocation:credit");
    // a positive opening balance takes an offset like an invoice
    const c2 = await contact();
    const debt2 = await setOb({ contact: c2 }, 900);
    const credit3 = await asAdmin(async (q) =>
      (await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, company_id, doc_type, amount_agorot) values ($1, $2, 'opening_balance', -300) returning id", [org, await company()])).id,
    );
    expect((await pgError(offset(owner, credit3, debt2, 100))).hint).toBe("allocation:customer");
  });

  it("released when the credit is replaced or the document cancelled; undone only by owners and admins; never deleted", async () => {
    const c = await contact();
    const credit = await setOb({ contact: c }, -1000);
    const inv = await invoice(c, 1000);
    const id = await offset(owner, credit, inv, 600);
    // a manager allocates, but does not change or undo
    expect(await run(manager, async (q) => (await q("update public.opening_credit_allocations set amount_agorot = 100 where id = $1", [id])).rowCount)).toBe(0);
    expect(await run(admin, async (q) => (await q("update public.opening_credit_allocations set amount_agorot = 500 where id = $1", [id])).rowCount)).toBe(1);
    expect((await pgError(run(admin, (q) => q("delete from public.opening_credit_allocations where id = $1", [id])))).code).toBe("42501");
    // a member who may not record payments: RLS
    expect((await pgError(offset(member, credit, inv, 1))).code).toBe("42501");
    // replacing the opening balance cancels it and releases its offsets
    await setOb({ contact: c }, -200);
    expect(await asAdmin((q) => count(q, "select 1 from public.opening_credit_allocations where id = $1 and released_at is not null", [id]))).toBe(1);
    expect(await state(inv)).toMatchObject({ state: "unpaid", balance: 1000 });
  });

  it("the customer's credit, the credit column and the ledger count the opening credit left", async () => {
    const co = await company();
    const worker = await contact(co);
    await setOb({ company: co }, -700);
    const own = await contact();
    await setOb({ contact: own }, -250);
    const card = await run(owner, async (q) =>
      (await one<{ c: { total: number; documents: { credit: number }[] } }>(q, "select public.money_customer_credit($1, null, $2, null) as c", [org, worker])).c,
    );
    expect(card.total).toBe(700);
    expect(card.documents.map((d) => d.credit)).toEqual([700]);
    // the kept totals (refreshed at commit)
    expect(await run(owner, async (q) => Number((await one<{ b: string }>(q, "select public.credit_balance(c) as b from public.companies c where c.id = $1", [co])).b))).toBe(700);
    expect(await run(owner, async (q) => Number((await one<{ b: string }>(q, "select public.credit_balance(c) as b from public.contacts c where c.id = $1", [own])).b))).toBe(250);
    // a contact moving to another company takes its opening credit with it
    const other = await company();
    await run(owner, (q) => q("update public.contacts set company_id = $2 where id = $1", [own, other]));
    expect(await run(owner, async (q) => Number((await one<{ b: string }>(q, "select public.credit_balance(c) as b from public.companies c where c.id = $1", [other])).b))).toBe(250);
    // the ledger's credit balance
    const l = await run(owner, async (q) =>
      (await one<{ l: { credit_balance: number } }>(q, "select public.customer_ledger($1, null, $2, '2026-01-01', '2026-12-31') as l", [org, co])).l,
    );
    expect(Number(l.credit_balance)).toBe(700);
  });

  it("the credit column follows a purge and a merge of the contact that holds the credit", async () => {
    const balance = (companyId: string) =>
      run(owner, async (q) => Number((await one<{ b: string }>(q, "select public.credit_balance(c) as b from public.companies c where c.id = $1", [companyId])).b));
    // purge: the company it sat on goes back to 0
    const x = await company();
    const gone = await contact(x);
    await setOb({ contact: gone }, -400);
    expect(await balance(x)).toBe(400);
    await asAdmin((q) => q("delete from public.contacts where id = $1", [gone]));
    expect(await balance(x)).toBe(0);
    // merge into a contact of another company: the credit moves with it
    const from = await company();
    const to = await company();
    const dup = await contact(from);
    const kept = await contact(to);
    await setOb({ contact: dup }, -300);
    expect([await balance(from), await balance(to)]).toEqual([300, 0]);
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, kept, dup]));
    expect([await balance(from), await balance(to)]).toEqual([0, 300]);
  });
});

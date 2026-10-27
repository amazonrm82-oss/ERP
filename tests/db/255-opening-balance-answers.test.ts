import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Applied = { allocated: number; payments: { payment_id: string; amount: number }[]; documents: { document_id: string; amount: number }[] };

/**
 * GAP-12 follow-up, the owner's answers of 27 October 2026 (DECISIONS.md "יתרת פתיחה: החלפה וסדר זיכוי"):
 * (1) ג an opening balance is never replaced while it holds a counted payment allocation or opening-credit offset (onto a
 *     debt, or from a credit); the allocations are released by hand first (hint opening_balance:allocated);
 * (2) ג the customer's credit is used oldest first across payments (paid_on) and opening credits (doc_date), ties by
 *     created_at then id; the advances of the document's order still come first.
 */
describe("opening balance answers (GAP-12 follow-up)", () => {
  let owner: U, admin: U;
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
  const setOb = (on: { contact?: string; company?: string }, amount: number, date = "2026-01-01", job: string | null = null, u: U = owner) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, $3, $4, $5, null, $6) as id", [org, on.contact ?? null, on.company ?? null, amount, date, job])
      ).id,
    );
  const invoice = (contactId: string, amount: number) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, '2026-05-01', $4) returning id", [
          org,
          contactId,
          `OBA-${++n}`,
          amount,
        ])
      ).id,
    );
  const pay = (contactId: string, amount: number, paidOn: string) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, 'transfer') returning id", [org, contactId, amount, paidOn])).id,
    );
  const allocate = (paymentId: string, documentId: string, amount: number) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4) returning id", [org, paymentId, documentId, amount])).id,
    );
  const offset = (credit: string, document: string, amount: number) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot) values ($1, $2, $3, $4) returning id", [
          org,
          credit,
          document,
          amount,
        ])
      ).id,
    );
  const status = (id: string) => asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.accounting_documents where id = $1", [id])).status);
  const apply = (document: string, max: number | null = null) =>
    run(owner, async (q) => (await one<{ a: Applied }>(q, "select public.money_apply_credit($1, $2, $3) as a", [org, document, max])).a);

  beforeAll(async () => {
    owner = await createUser("oba-owner");
    org = await createOrg(owner.id, "עסק התשובות");
    admin = await addMember(org, owner.id, "admin", "oba-admin");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ documents: true, payments: true, balances: true })]),
    );
  });

  it("(1) ג a debt with a payment allocation is not replaced; once the allocation is undone, it is", async () => {
    const c = await contact();
    const debt = await setOb({ contact: c }, 5000);
    const allocation = await allocate(await pay(c, 2000, "2026-02-01"), debt, 2000);
    const err = await pgError(setOb({ contact: c }, 7000, "2026-01-01", null, admin));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("opening_balance:allocated");
    // nothing changed: the old balance is active, the allocation counted, no second balance
    expect(await status(debt)).toBe("active");
    expect(await asAdmin((q) => count(q, "select 1 from public.payment_allocations where id = $1 and released_at is null and removed_at is null", [allocation]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where contact_id = $1 and doc_type = 'opening_balance'", [c]))).toBe(1);
    // released by hand (an owner or admin undoes it): the replace goes through
    expect(await run(admin, async (q) => (await q("update public.payment_allocations set removed_at = now() where id = $1", [allocation])).rowCount)).toBe(1);
    const next = await setOb({ contact: c }, 7000);
    expect(await status(debt)).toBe("cancelled");
    expect(await status(next)).toBe("active");
  });

  it("(1) ג an offset blocks the replace on both sides: the debt it went to and the credit it came from", async () => {
    const co = await company();
    const worker = await contact(co);
    const credit = await setOb({ company: co }, -3000);
    const debt = await setOb({ contact: worker }, 2000);
    const id = await offset(credit, debt, 1500);
    expect((await pgError(setOb({ contact: worker }, 2500))).hint).toBe("opening_balance:allocated");
    expect((await pgError(setOb({ company: co }, -4000))).hint).toBe("opening_balance:allocated");
    expect(await status(credit)).toBe("active");
    expect(await status(debt)).toBe("active");
    // an offset released by the server (its document cancelled by hand) no longer counts
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'בדיקה' where id = $1", [debt]));
    expect(await asAdmin((q) => count(q, "select 1 from public.opening_credit_allocations where id = $1 and released_at is not null", [id]))).toBe(1);
    const credit2 = await setOb({ company: co }, -4000);
    expect(await status(credit)).toBe("cancelled");
    expect(await status(credit2)).toBe("active");
    // an offset undone by an admin no longer counts either
    const worker2 = await contact(co);
    const debt2 = await setOb({ contact: worker2 }, 1000);
    const id2 = await offset(credit2, debt2, 400);
    expect((await pgError(setOb({ contact: worker2 }, 900))).hint).toBe("opening_balance:allocated");
    expect(await run(admin, async (q) => (await q("update public.opening_credit_allocations set removed_at = now() where id = $1", [id2])).rowCount)).toBe(1);
    await setOb({ contact: worker2 }, 900);
    expect(await status(debt2)).toBe("cancelled");
  });

  it("(1) ג the import's replace is refused with the same hint, row by row, and the next row's balance is still written", async () => {
    const allocated = await contact();
    const free = await contact();
    const debt = await setOb({ contact: allocated }, 3000);
    await allocate(await pay(allocated, 1000, "2026-02-01"), debt, 1000);
    const before = await setOb({ contact: free }, 100);
    const job = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'oba.csv', 'update') returning id", [org])).id,
    );
    // each row is its own call (src/features/imports/server.ts recordOpenings): a refusal answers that row only
    expect((await pgError(setOb({ contact: allocated }, 3500, "2026-01-01", job))).hint).toBe("opening_balance:allocated");
    const replaced = await setOb({ contact: free }, 200, "2026-01-01", job);
    expect(await status(debt)).toBe("active");
    expect(await status(before)).toBe("cancelled");
    expect(await status(replaced)).toBe("active");
    expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where import_job_id = $1", [job]))).toBe(1);
  });

  it("(2) ג credit is used oldest first across payments and opening credits; a date tie goes by created_at", async () => {
    const c = await contact();
    const later = await pay(c, 1000, "2026-03-01");
    const opening = await setOb({ contact: c }, -1000, "2026-01-15");
    // the same date as the opening credit, recorded after it: after it
    const sameDay = await pay(c, 1000, "2026-01-15");
    const oldest = await pay(c, 1000, "2026-01-10");
    const inv = await invoice(c, 10000);
    // the cap shows the order: 2,500 takes the oldest payment, the opening credit, then half of the same-day payment
    const r = await apply(inv, 2500);
    expect(r.allocated).toBe(2500);
    expect(r.payments).toEqual([
      { payment_id: oldest, amount: 1000 },
      { payment_id: sameDay, amount: 500 },
    ]);
    expect(r.documents).toEqual([{ document_id: opening, amount: 1000 }]);
    // the rest, in order: what is left of the same-day payment, then the later one
    const r2 = await apply(inv, 1000);
    expect(r2.payments).toEqual([
      { payment_id: sameDay, amount: 500 },
      { payment_id: later, amount: 500 },
    ]);
    expect(r2.documents).toEqual([]);
  });

  it("(2) ג a payment on the same day recorded before the opening credit comes first; an older opening credit beats a newer payment", async () => {
    const c = await contact();
    const first = await pay(c, 1000, "2026-02-01");
    const opening = await setOb({ contact: c }, -1000, "2026-02-01");
    const inv = await invoice(c, 10000);
    const r = await apply(inv, 1000);
    expect(r.payments).toEqual([{ payment_id: first, amount: 1000 }]);
    expect(r.documents).toEqual([]);
    expect((await apply(inv, 1000)).documents).toEqual([{ document_id: opening, amount: 1000 }]);
    const c2 = await contact();
    await pay(c2, 1000, "2026-04-01");
    const older = await setOb({ contact: c2 }, -1000, "2026-01-01");
    const r2 = await apply(await invoice(c2, 10000), 600);
    expect(r2.payments).toEqual([]);
    expect(r2.documents).toEqual([{ document_id: older, amount: 600 }]);
  });
});

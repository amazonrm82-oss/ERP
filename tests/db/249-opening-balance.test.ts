import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * GAP-12 (owner, 26 October 2026, answers (1) א, (3) ב, (4) ג, (5) ב): an imported customer's opening balance is an
 * accounting document of type `opening_balance`: no running number, a signed amount (negative = a credit), on a contact or
 * a company, one active per customer (a new one replaces it through public.opening_balance_set), recorded, changed and
 * cancelled by owners and admins only, no automatic due date, no document_recorded automation, and counted like a regular
 * document in the ledger, in allocations and in collection.
 */
describe("opening balance (GAP-12)", () => {
  let owner: U, admin: U, manager: U, keyHolder: U, stranger: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const contact = (terms: { terms: string; days: number | null } | null = null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.contacts (organization_id, first_name, owner_id, payment_terms, payment_days) values ($1, $2, $3, $4, $5) returning id",
          [org, `לקוח ${++n}`, owner.id, terms?.terms ?? null, terms?.days ?? null],
        )
      ).id,
    );
  const opening = (u: U, contactId: string, amount: number, date = "2026-01-01", extra: { number?: string | null; due?: string | null; order?: string | null } = {}) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date, order_id) values ($1, $2, 'opening_balance', $3, $4, $5, $6, $7) returning id",
          [org, contactId, extra.number ?? null, date, amount, extra.due ?? null, extra.order ?? null],
        )
      ).id,
    );
  const company = () =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, `חברה ${++n}`, owner.id])).id);
  const contactAt = (companyId: string) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, $2, $3, $4) returning id", [org, `עובד ${++n}`, owner.id, companyId])).id,
    );
  // the replace path (the card and the import)
  const setOb = (u: U, on: { contact?: string; company?: string }, amount: number, date = "2026-01-01", due: string | null = null, job: string | null = null) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, $3, $4, $5, $6, $7) as id", [
          org,
          on.contact ?? null,
          on.company ?? null,
          amount,
          date,
          due,
          job,
        ])
      ).id,
    );
  const doc = (type: string, contactId: string, amount: number, number: string | null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, $3, $4, '2026-02-01', $5) returning id",
          [org, contactId, type, number, amount],
        )
      ).id,
    );
  const row = (id: string) =>
    asAdmin((q) =>
      one<{ number: string | null; amount_agorot: string; due_date: string | null; status: string; cancel_reason: string | null; company_id: string | null }>(
        q,
        "select number, amount_agorot, to_char(due_date, 'YYYY-MM-DD') as due_date, status, cancel_reason, company_id from public.accounting_documents where id = $1",
        [id],
      ),
    );
  const pay = (contactId: string, amount: number) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, '2026-03-01', 'transfer') returning id",
          [org, contactId, amount],
        )
      ).id,
    );
  const allocate = (paymentId: string, documentId: string, amount: number) =>
    run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, paymentId, documentId, amount]));
  const state = (id: string) =>
    run(owner, async (q) => (await one<{ s: { state: string; balance: number; paid: number } }>(q, "select public.money_allocation_state($1, array[$2]::uuid[], '{}') -> 'documents' -> 0 as s", [org, id])).s);

  beforeAll(async () => {
    owner = await createUser("ob-owner");
    org = await createOrg(owner.id, "עסק היתרות");
    admin = await addMember(org, owner.id, "admin", "ob-admin");
    manager = await addMember(org, owner.id, "manager", "ob-manager");
    keyHolder = await addMember(org, owner.id, "member", "ob-key");
    stranger = await createUser("ob-stranger");
    otherOrg = await createOrg(stranger.id, "עסק אחר");
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [
        org,
        JSON.stringify({ documents: true, payments: true, balances: true, granular_permissions: true }),
      ]),
    );
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents}')", [org, keyHolder.id]));
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
  });

  it("has no number, a signed amount that is never 0, never a deal; every other type keeps its number and its rules", async () => {
    const c = await contact();
    const debt = await opening(owner, c, 50000, "2026-01-01", { number: "17" });
    expect(await row(debt)).toMatchObject({ number: null, amount_agorot: "50000", status: "active" });
    const c2 = await contact();
    expect((await row(await opening(admin, c2, -20000))).amount_agorot).toBe("-20000");
    expect((await pgError(opening(owner, await contact(), 0))).code).toBe("23514");
    // the others: a number is required, never negative, never a company, and the type+number pair stays unique
    expect((await pgError(doc("tax_invoice", c, 100, null))).code).toBe("23514");
    expect((await pgError(doc("credit_invoice", c, -100, "CR-1"))).code).toBe("23514");
    await doc("tax_invoice", c, 100, "OB-INV-1");
    expect((await pgError(doc("tax_invoice", c, 100, "OB-INV-1"))).hint).toBe("document:duplicate");
    const co = await company();
    expect(
      (await pgError(run(owner, (q) => q("insert into public.accounting_documents (organization_id, company_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'R-co', 5)", [org, co])))).code,
    ).toBe("23514");
    // an opening balance is never on a deal, nor on a contact and a company at once
    const deal = await run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          owner.id,
        ])
      ).id,
    );
    expect(
      (await pgError(run(owner, (q) => q("insert into public.accounting_documents (organization_id, deal_id, doc_type, amount_agorot) values ($1, $2, 'opening_balance', 5)", [org, deal])))).code,
    ).toBe("23514");
    const both = await contact();
    expect(
      (
        await pgError(
          run(owner, (q) =>
            q("insert into public.accounting_documents (organization_id, contact_id, company_id, doc_type, amount_agorot) values ($1, $2, $3, 'opening_balance', 5)", [org, both, co]),
          ),
        )
      ).code,
    ).toBe("23514");
    // a number sent by any writer never reaches the table
    const serverMade = await asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'opening_balance', 'X', 5) returning id",
          [org, await contact()],
        )
      ).id,
    );
    expect((await row(serverMade)).number).toBeNull();
    // no order
    expect((await pgError(opening(owner, await contact(), 100, "2026-01-01", { order: "00000000-0000-0000-0000-000000000001" }))).hint).toBe("document:opening_balance");
  });

  it("owners and admins only: recording, replacing, the due date and cancelling; a stranger meets RLS", async () => {
    const c = await contact();
    expect((await pgError(opening(manager, c, 100))).hint).toBe("document:opening_admin");
    expect((await pgError(opening(keyHolder, c, 100))).hint).toBe("document:opening_admin");
    expect((await pgError(setOb(manager, { contact: c }, 100))).code).toBe("42501");
    // the same people still record a regular document
    await run(manager, (q) =>
      q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', $3, 100)", [org, c, `OB-R-${++n}`]),
    );
    const id = await opening(admin, c, 100, "2026-01-01");
    expect(
      (await pgError(run(manager, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [id])))).hint,
    ).toBe("document:opening_admin");
    expect((await pgError(run(manager, (q) => q("update public.accounting_documents set due_date = '2026-05-01' where id = $1", [id])))).hint).toBe(
      "document:opening_admin",
    );
    await run(admin, (q) => q("update public.accounting_documents set due_date = '2026-05-01' where id = $1", [id]));
    expect((await row(id)).due_date).toBe("2026-05-01");
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'נרשם פעמיים' where id = $1", [id]));
    expect((await row(id)).status).toBe("cancelled");
    // a member of another business: RLS's plain refusal, nothing about this one
    expect((await pgError(opening(stranger, c, 100))).code).toBe("42501");
    expect((await pgError(setOb(stranger, { contact: c }, 100))).code).toBe("42501");
    expect(await run(stranger, (q) => count(q, "select 1 from public.accounting_documents where organization_id = $1", [org]))).toBe(0);
    void otherOrg;
  });

  it("one active opening balance per customer: a second insert is refused, the replace path cancels the old one", async () => {
    const c = await contact();
    const first = await setOb(owner, { contact: c }, 1000);
    expect((await pgError(opening(owner, c, 500))).hint).toBe("document:opening_exists");
    const second = await setOb(admin, { contact: c }, -700);
    expect(await row(first)).toMatchObject({ status: "cancelled", cancel_reason: "הוחלפה ביתרה חדשה" });
    expect(await row(second)).toMatchObject({ status: "active", amount_agorot: "-700" });
    // from an import: the caller's own running contacts job, and the import's reason
    const job = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'a.csv', 'update') returning id", [org])).id,
    );
    expect((await pgError(setOb(admin, { contact: c }, 300, "2026-01-01", null, job))).hint).toBe("document:opening_job");
    expect((await pgError(setOb(owner, { company: await company() }, 300, "2026-01-01", null, job))).hint).toBe("document:opening_job");
    const third = await setOb(owner, { contact: c }, 300, "2026-01-01", null, job);
    expect(await row(second)).toMatchObject({ status: "cancelled", cancel_reason: "הוחלפה בייבוא" });
    expect((await row(third)).status).toBe("active");
    expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where contact_id = $1 and status = 'active'", [c]))).toBe(1);
    // audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'accounting_documents' and entity_id = $1 and action = 'update'", [second]))).toBe(1);
    expect((await pgError(setOb(owner, { contact: c }, 0))).hint).toBe("document:opening_amount");
    expect((await pgError(setOb(owner, {}, 10))).hint).toBe("document:parent");
  });

  it("no automatic due date (answer (4) ג), only a typed one on a debt", async () => {
    const c = await contact({ terms: "net", days: 30 });
    expect((await row(await setOb(owner, { contact: c }, 1000, "2026-01-01"))).due_date).toBeNull();
    expect((await row(await setOb(owner, { contact: c }, 1000, "2026-01-01", "2026-03-01"))).due_date).toBe("2026-03-01");
    expect((await row(await setOb(owner, { contact: c }, -1000, "2026-01-01"))).due_date).toBeNull();
    expect((await pgError(setOb(owner, { contact: c }, -1000, "2026-01-01", "2026-03-01"))).hint).toBe("document:due_date");
    // a regular invoice still takes the terms
    const inv = await run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', $3, '2026-01-01', 100) returning id", [
          org,
          c,
          `OB-T-${++n}`,
        ])
      ).id,
    );
    expect((await row(inv)).due_date).toBe("2026-01-31");
  });

  it("a company's opening balance: read with the company, paid by its people, in its ledger and its contacts', moved by a merge, reached by an erasure", async () => {
    const co = await company();
    const worker = await contactAt(co);
    const ob = await setOb(owner, { company: co }, 9000, "2026-01-01");
    expect((await row(ob)).company_id).toBe(co);
    // whoever reads the company reads it
    expect(await run(keyHolder, (q) => count(q, "select 1 from public.accounting_documents where id = $1", [ob]))).toBe(1);
    // the timeline entry is on the company
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where company_id = $1 and metadata ->> 'document_id' = $2", [co, ob]))).toBe(1);
    // a payment of the company's contact is allocated to it; an outsider's is not
    const p = await pay(worker, 4000);
    const offered = await run(owner, async (q) =>
      (await one<{ d: { id: string }[] }>(q, "select public.money_allocation_candidates($1, $2, null) -> 'documents' as d", [org, p])).d.map((d) => d.id),
    );
    expect(offered).toContain(ob);
    await allocate(p, ob, 4000);
    expect(await state(ob)).toMatchObject({ state: "partial", balance: 5000 });
    expect((await pgError(allocate(await pay(await contact(), 100), ob, 100))).hint).toBe("allocation:customer");
    // the ledger of the company and of its contact
    for (const where of [
      [null, co],
      [worker, null],
    ]) {
      const l = await run(owner, async (q) =>
        (await one<{ l: { lines: { id: string; debit: number }[] } }>(q, "select public.customer_ledger($1, $2, $3, '2026-01-01', '2026-12-31') as l", [org, where[0], where[1]])).l,
      );
      expect(l.lines.find((x) => x.id === ob)?.debit).toBe(9000);
    }
    // a company merge moves it to the kept company
    const kept = await company();
    await run(owner, (q) => q("select public.merge_records($1, 'company', $2, $3, '{}'::jsonb)", [org, kept, co]));
    expect((await row(ob)).company_id).toBe(kept);
    // an erasure of a purged company reaches its documents: a cancel reason is neutralised, the entries are erased
    const gone = await company();
    const ob2 = await setOb(owner, { company: gone }, 100);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'החברה של דני' where id = $1", [ob2]));
    await asAdmin((q) => q("delete from public.companies where id = $1", [gone]));
    await asAdmin((q) => q("select app.audit_erase_core($1, 'companies', $2, null)", [org, gone]));
    expect((await row(ob2)).cancel_reason).toBe("הסיבה נמחקה (מחיקת פרטיות)");
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'accounting_documents' and entity_id = $1 and changes <> '{\"erased\": true}'::jsonb", [ob2])),
    ).toBe(0);
  });

  it("allocations: a debt takes payments like a tax invoice; a credit takes none and has no balance", async () => {
    const c = await contact();
    const debt = await setOb(owner, { contact: c }, 10000);
    const credit = await setOb(owner, { contact: await contact() }, -5000);
    expect(await state(debt)).toMatchObject({ state: "unpaid", balance: 10000, paid: 0 });
    expect(await state(credit)).toMatchObject({ state: "none", balance: 0 });
    const p = await pay(c, 4000);
    await allocate(p, debt, 4000);
    expect(await state(debt)).toMatchObject({ state: "partial", balance: 6000, paid: 4000 });
    const p2 = await pay(c, 9000);
    expect((await pgError(allocate(p2, debt, 7000))).hint).toBe("allocation:document_over");
    // the window offers the debt to the payment
    const offered = await run(owner, async (q) =>
      (await one<{ d: { id: string }[] }>(q, "select public.money_allocation_candidates($1, $2, null) -> 'documents' as d", [org, p2])).d.map((d) => d.id),
    );
    expect(offered).toContain(debt);
    // PAY-03: the customer's credit is applied to the debt
    const applied = await run(owner, async (q) => (await one<{ r: { allocated: number } }>(q, "select public.money_apply_credit($1, $2) as r", [org, debt])).r);
    expect(applied.allocated).toBe(6000);
    expect(await state(debt)).toMatchObject({ state: "paid", balance: 0 });
  });

  it("the ledger: a debt is a debit, a credit is a credit; open debt counts the debt's balance", async () => {
    const co = await company();
    const c = await contactAt(co);
    await setOb(owner, { company: co }, 30000, "2026-01-01");
    await setOb(owner, { contact: c }, -8000, "2026-01-02");
    await pay(c, 2000);
    const l = await run(owner, async (q) =>
      (
        await one<{ l: { closing: number; open_debt: number; lines: { type: string; debit: number; credit: number; amount: number; label: string | null }[] } }>(
          q,
          "select public.customer_ledger($1, $2, null, '2026-01-01', '2026-12-31') as l",
          [org, c],
        )
      ).l,
    );
    expect(l.lines.map((x) => [x.type, Number(x.debit), Number(x.credit), Number(x.amount)])).toEqual([
      ["opening_balance", 30000, 0, 30000],
      ["opening_balance", 0, 8000, -8000],
      ["transfer", 0, 2000, 2000],
    ]);
    expect(l.lines[0].label).toBeNull();
    expect(Number(l.closing)).toBe(20000);
    expect(Number(l.open_debt)).toBe(30000);
  });

  it("an opening balance never fires the document_recorded trigger (a historical balance); a regular document still does", async () => {
    const c = await contact();
    const events = () =>
      asAdmin((q) => count(q, "select 1 from public.outbox_events where organization_id = $1 and event_type = 'document_recorded' and entity_id = $2", [org, c]));
    await setOb(owner, { contact: c }, 1000);
    await setOb(owner, { contact: c }, -1000);
    expect(await events()).toBe(0);
    // its timeline entries are still written (recorded twice, and the replaced one cancelled)
    expect(
      await asAdmin((q) => count(q, "select 1 from public.activities where organization_id = $1 and contact_id = $2 and metadata ->> 'kind' = 'document_recorded'", [org, c])),
    ).toBe(2);
    await doc("tax_invoice", c, 1000, `OB-EV-${++n}`);
    expect(await events()).toBe(1);
  });

  it("the timeline names it by its date; a typed due date already past fires debt_overdue", async () => {
    const c = await contact();
    const id = await setOb(owner, { contact: c }, 1000, "2026-01-01", "2026-01-15");
    const body = await asAdmin(async (q) =>
      (await one<{ body: string }>(q, "select body from public.activities where organization_id = $1 and metadata ->> 'document_id' = $2", [org, id])).body,
    );
    expect(body).toBe("נרשם מסמך: יתרת פתיחה מתאריך 01.01.2026");
    const auto = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, actions)
           values ($1, 'חוב פתיחה', 'contact', 'debt_overdue', '{}', '[{"type": "notify", "to": "owner", "title": "חוב"}]') returning id`,
          [org],
        )
      ).id,
    );
    await asAdmin(async (q) => {
      await q("select set_config('app.date_trigger_hour', '0', true)");
      await q("select app.run_debt_automations()");
    });
    const keys = await asAdmin(async (q) => (await q<{ k: string }>("select run_key as k from public.automation_runs where automation_id = $1 and entity_id = $2", [auto, c])).rows.map((r) => r.k));
    expect(keys).toEqual([`debt:${id}:2026-01-15:0`]);
    await asAdmin((q) => q("update public.automations set is_active = false where id = $1", [auto]));
  });

  it("an import's own opening balances are part of it: not work, cancelled by its undo; a replaced one is not restored", async () => {
    // only owners and admins record an opening balance, and only into their own running job, so the job's own balances
    // reach public.undo_import (undo_own_import is for a member who holds the import permission, PRM-01)
    const job = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'ob.csv', 'skip') returning id", [org])).id,
    );
    const c = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, import_job_id) values ($1, $2, $3) returning id", [org, `מיובא ${++n}`, job])).id,
    );
    const ob = await setOb(owner, { contact: c }, 4200, "2026-01-01", null, job);
    // an existing customer's balance that the same import replaces
    const old = await contact();
    const before = await setOb(owner, { contact: old }, 100);
    const replaced = await setOb(owner, { contact: old }, 300, "2026-01-01", null, job);
    await run(owner, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    // the job's own balance and its timeline entry are not work on the imported contact
    expect(await asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 hour', $3) as w", [org, c, job])).w)).toBe(false);
    const r = await run(owner, async (q) => (await one<{ r: { opening_balances?: number } }>(q, "select public.undo_import($1, $2) as r", [org, job])).r);
    // an owner's undo of an untouched job cancels the balance of the record it moved to the bin ...
    expect(r.opening_balances).toBe(1);
    expect(await row(ob)).toMatchObject({ status: "cancelled", cancel_reason: "בוטל עם ביטול הייבוא" });
    // ... and leaves the balance on a record it keeps (an existing customer the import wrote to) active
    expect((await row(replaced)).status).toBe("active");
    // the balance it replaced stays replaced (not restored)
    expect(await row(before)).toMatchObject({ status: "cancelled", cancel_reason: "הוחלפה בייבוא" });
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1 and deleted_at is not null", [c]))).toBe(1);
    // null-safe: a system entry without a kind is still work (the opening-balance exclusion never swallows it)
    await asAdmin((q) => q("insert into public.activities (organization_id, contact_id, type, body, metadata) values ($1, $2, 'system', 'x', '{}')", [org, c]));
    expect(await asAdmin(async (q) => (await one<{ w: boolean }>(q, "select app.import_record_worked($1, 'contact', $2, now() - interval '1 hour', $3) as w", [org, c, job])).w)).toBe(true);
    // nobody else cancels through the undo path: the helper needs the caller's own undone job
    expect((await pgError(run(admin, (q) => q("select app.import_opening_cancel($1, $2)", [org, job])))).code).toBe("42501");

    // a balance recorded outside the import is work: a member's self-undo keeps the contact
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents,import}')", [org, keyHolder.id]));
    const job2 = await run(keyHolder, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'ob2.csv', 'skip') returning id", [org])).id,
    );
    const c2 = await run(keyHolder, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `מיובא ${++n}`, keyHolder.id, job2])).id,
    );
    await run(keyHolder, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job2]));
    const outside = await setOb(owner, { contact: c2 }, 500);
    expect(await run(keyHolder, async (q) => (await one<{ r: { done: number; kept: number } }>(q, "select public.undo_own_import($1, $2) as r", [org, job2])).r)).toMatchObject({ done: 0, kept: 1 });
    expect((await row(outside)).status).toBe("active");
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents}')", [org, keyHolder.id]));
  });

  it("a manager's or member's undo never cancels an opening balance, even of a former admin's own job", async () => {
    // an admin records a balance into their own import, is then made a member holding the import key (PRM-01)
    const former = await addMember(org, owner.id, "admin", `ob-former-${++n}`);
    const job = await run(former, async (q) =>
      (await one<{ id: string }>(q, "insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'contact', 'ob3.csv', 'skip') returning id", [org])).id,
    );
    const c = await run(former, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, import_job_id) values ($1, $2, $3, $4) returning id", [org, `מיובא ${++n}`, former.id, job])).id,
    );
    const ob = await setOb(former, { contact: c }, 900, "2026-01-01", null, job);
    await run(former, (q) => q("update public.import_jobs set status = 'done' where id = $1", [job]));
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, former.id]));
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{import}')", [org, former.id]));
    const r = await run(former, async (q) => (await one<{ r: { done: number; opening_balances?: number } }>(q, "select public.undo_own_import($1, $2) as r", [org, job])).r);
    expect(r.done).toBe(1);
    expect(r.opening_balances).toBeUndefined();
    expect((await row(ob)).status).toBe("active");
  });

  it("the documents list sorts and names a company's opening balance by the company", async () => {
    const co = await company();
    const ob = await setOb(owner, { company: co }, 1200);
    const names = await run(owner, async (q) =>
      (await q<{ s: string | null; n: string }>("select public.sort_customer(d) as s, (select name from public.companies where id = $2) as n from public.accounting_documents d where d.id = $1", [ob, co])).rows[0],
    );
    expect(names.s).toBe(names.n);
    // a contact's still wins (unchanged rule)
    const c = await contact();
    const ob2 = await setOb(owner, { contact: c }, 50);
    expect(await run(owner, async (q) => (await one<{ s: string }>(q, "select public.sort_customer(d) as s from public.accounting_documents d where d.id = $1", [ob2])).s)).toMatch(/^לקוח /);
  });
});

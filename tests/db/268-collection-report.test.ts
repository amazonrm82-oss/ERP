import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPORTS } from "../../src/features/reports/definitions";
import { parseReportData } from "../../src/features/reports/schemas";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * COL-06: the collection report. public.report_collection(org, from, to, owner) (invoker): payments recorded or confirmed
 * whose paid_on is in [from, to], by month, method and rep (COL-01's rule: deal's owner, else contact's, else none), and
 * the collection days of the debt documents fully paid in the period (null below 5). COL-01's rights (BAL-01's rule with the
 * collection, documents and payments keys) and partial rule (rows the caller reads, no totals).
 */
describe("collection report (COL-06)", () => {
  let owner: U, manager: U, member: U, keyHolder: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, collection: true, granular_permissions: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const company = (name: string, ownerId: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, ownerId])).id);
  // a contact with no owner is made by the server (a person's insert gets the creator as owner)
  const contact = (name: string, ownerId: string | null, companyId: string | null = null) =>
    (ownerId === null ? asAdmin : (fn: (q: Query) => Promise<string>) => run(owner, fn))(async (q: Query) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, ownerId])).id,
    );
  const deal = (name: string, contactId: string | null, ownerId: string) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, name, pipelineId, stageId, contactId, ownerId],
        )
      ).id,
    );
  const pay = (amount: number, on: string, method: string, where: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method, installments) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, where.deal ?? null, where.contact ?? null, amount, on, method, method === "credit" ? 1 : null],
        )
      ).id,
    );
  const doc = (amount: number, docDate: string, due: string | null, contactId: string, type = "tax_invoice") =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, $3, $4, $5, $6, $7) returning id",
          [org, contactId, type, `CR-${++n}`, docDate, amount, due],
        )
      ).id,
    );
  const allocate = (payment: string, document: string, amount: number) =>
    run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, payment, document, amount]));
  const report = (u: U, from: string, to: string, ownerId: string | null = null) =>
    run(u, async (q) => parseReportData("report_collection", (await one<{ r: unknown }>(q, "select public.report_collection($1, $2, $3, $4) as r", [org, from, to, ownerId])).r));
  const full = async (u: U, from: string, to: string, ownerId: string | null = null) => {
    const r = await report(u, from, to, ownerId);
    if (!r.allowed) throw new Error("expected the report");
    return r;
  };

  let repContact: string, keyContact: string, orphanContact: string, coContact: string, managerDeal: string;

  beforeAll(async () => {
    owner = await createUser("cr-owner");
    org = await createOrg(owner.id, "עסק דוח הגבייה");
    manager = await addMember(org, owner.id, "manager", "cr-manager");
    member = await addMember(org, owner.id, "member", "cr-member");
    keyHolder = await addMember(org, owner.id, "member", "cr-key");
    viewer = await addMember(org, owner.id, "viewer", "cr-viewer");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string }>(
        q,
        "select p.id as p, s.id as s from public.pipelines p join public.stages s on s.pipeline_id = p.id where p.organization_id = $1 and p.is_default and s.kind = 'open' order by s.position limit 1",
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, keyHolder.id]));

    repContact = await contact("רינה", owner.id);
    keyContact = await contact("קובי", keyHolder.id);
    orphanContact = await contact("יתום", null);
    const co = await company("חברת הגבייה", manager.id);
    coContact = await contact("בחברה", null, co);
    managerDeal = await deal("עסקת המנהל", repContact, manager.id);

    // the period of the first tests: August and September 2026
    await pay(1000, "2026-07-31", "cash", { contact: repContact }); // before the period
    await pay(2000, "2026-08-31", "cash", { contact: repContact }); // last day of August: August
    await pay(4000, "2026-09-01", "transfer", { deal: managerDeal }); // the deal's owner, not the contact's
    await pay(8000, "2026-09-30", "credit", { contact: keyContact });
    await pay(16000, "2026-09-15", "bit_paybox", { contact: orphanContact }); // no rep
    await pay(32000, "2026-09-16", "transfer", { contact: coContact }); // no rep: a payment has no company (COL-01's rule)
    await pay(64000, "2026-10-01", "cash", { contact: repContact }); // after the period
    // not counted: failed, refunded and cancelled
    const failed = await pay(500, "2026-09-10", "cash", { contact: repContact });
    const cancelled = await pay(700, "2026-09-11", "cash", { contact: repContact });
    await run(owner, async (q) => {
      await q("update public.payments set status = 'failed' where id = $1", [failed]);
      await q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]);
    });
  });

  it("counts recorded and confirmed payments by month (the last day of a month in it), method and rep", async () => {
    const r = await full(owner, "2026-08-01", "2026-09-30");
    expect(r.partial).toBe(false);
    expect(r.totals).toEqual({ amount: 62000, payments: 5 });
    expect(r.by_month).toEqual([
      { month: "2026-08-01", amount: 2000, payments: 1 },
      { month: "2026-09-01", amount: 60000, payments: 4 },
    ]);
    expect(r.by_method).toEqual([
      { method: "transfer", amount: 36000, payments: 2 },
      { method: "bit_paybox", amount: 16000, payments: 1 },
      { method: "credit", amount: 8000, payments: 1 },
      { method: "cash", amount: 2000, payments: 1 },
    ]);
    const reps = new Map(r.by_rep.map((x) => [x.owner_id, x.amount]));
    expect(Object.fromEntries(reps)).toEqual({ [manager.id]: 4000, [keyHolder.id]: 8000, [owner.id]: 2000, null: 48000 });
    // every month of the period, empty ones too; a confirmed payment counts
    const quiet = await full(owner, "2026-06-01", "2026-08-31");
    expect(quiet.by_month.map((m) => [m.month, m.amount])).toEqual([
      ["2026-06-01", 0],
      ["2026-07-01", 1000],
      ["2026-08-01", 2000],
    ]);
    // the rep filter
    const mine = await full(owner, "2026-08-01", "2026-09-30", manager.id);
    expect(mine.totals).toEqual({ amount: 4000, payments: 1 });
    expect(mine.by_rep.map((x) => x.owner_id)).toEqual([manager.id]);
  });

  it("a period the wrong way round or over ten years is refused", async () => {
    expect(await pgError(run(owner, (q) => q("select public.report_collection($1, '2026-09-30', '2026-08-01')", [org])))).toMatchObject({ code: "22023" });
    expect(await pgError(run(owner, (q) => q("select public.report_collection($1, '2010-01-01', '2026-08-01')", [org])))).toMatchObject({ code: "22023" });
  });

  it("collection days: documents fully paid in the period, average and median, days late, null below 5", async () => {
    const c = await contact("ימים", owner.id);
    // five invoices of 1 November, due 15 November, each paid in full on a later day of the period: 10, 20, 30, 40, 50 days
    const paidOn = ["2026-11-11", "2026-11-21", "2026-12-01", "2026-12-11", "2026-12-21"];
    const docs: string[] = [];
    for (const [i, on] of paidOn.entries()) {
      const d = await doc(1000, "2026-11-01", "2026-11-15", c);
      docs.push(d);
      if (i === 4) {
        // the last one in two payments, the last one dated in the period
        await allocate(await pay(400, "2026-11-05", "cash", { contact: c }), d, 400);
        await allocate(await pay(600, on, "cash", { contact: c }), d, 600);
      } else {
        await allocate(await pay(1000, on, "cash", { contact: c }), d, 1000);
      }
    }
    // not counted: paid in part; paid in full after the period; a receipt
    const part = await doc(1000, "2026-11-01", null, c);
    await allocate(await pay(500, "2026-11-20", "cash", { contact: c }), part, 500);
    const later = await doc(1000, "2026-11-01", null, c);
    await allocate(await pay(1000, "2027-01-05", "cash", { contact: c }), later, 1000);
    await doc(1000, "2026-11-01", null, c, "receipt");

    const r = await full(owner, "2026-11-01", "2026-12-31");
    expect(r.collection_days).toEqual({
      min_documents: 5,
      documents: 5,
      average_days: 30,
      median_days: 30,
      with_due_date: 5,
      // due 15 November: 0 (paid on the 11th), 6, 16, 26, 36
      average_days_late: 16.8,
      late_documents: 4,
    });
    // four documents: the counts, no average
    const four = await full(owner, "2026-11-01", "2026-12-15");
    expect(four.collection_days).toMatchObject({ documents: 4, average_days: null, median_days: null, average_days_late: null });
    // a cancelled payment releases its allocation: the document is no longer paid
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'החזר' where id in (select payment_id from public.payment_allocations where document_id = $1)", [docs[0]]));
    expect((await full(owner, "2026-11-01", "2026-12-31")).collection_days.documents).toBe(4);
  });

  it("collection days through a billed proforma, a cancelled proforma, and opening-credit offsets dated in the business's zone", async () => {
    const c = await contact("פרופורמה", owner.id);
    const docOf = (amount: number, docDate: string, type: string, proforma: string | null = null) =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, proforma_id) values ($1, $2, $3, $4, $5, $6, $7) returning id",
            [org, c, type, `PF-${++n}`, docDate, amount, proforma],
          )
        ).id,
      );
    // A: a proforma of 1 February paid in part (10 February), billed by an invoice of 5 February paid the rest on 25 February:
    // 24 days, from the PROFORMA's date (owner's answer (2) ב, 29 October 2026), not 20 from the invoice's
    const pA = await docOf(1000, "2027-02-01", "proforma");
    await allocate(await pay(600, "2027-02-10", "cash", { contact: c }), pA, 600);
    const iA = await docOf(1000, "2027-02-05", "tax_invoice", pA);
    await allocate(await pay(400, "2027-02-25", "cash", { contact: c }), iA, 400);
    // B: a proforma paid in full on 12 February, billed by an invoice of 1 February: 11 days
    const pB = await docOf(1000, "2027-02-01", "proforma");
    await allocate(await pay(1000, "2027-02-12", "cash", { contact: c }), pB, 1000);
    await docOf(1000, "2027-02-01", "tax_invoice", pB);
    // C: an invoice of 1 February paid on 14 February (13 days) whose proforma of 20 January, paid on 27 February, is then
    // cancelled: a cancelled proforma leaves the invoice's own date
    const pC = await docOf(1000, "2027-01-20", "proforma");
    await allocate(await pay(1000, "2027-02-27", "cash", { contact: c }), pC, 1000);
    const iC = await docOf(1000, "2027-02-01", "tax_invoice", pC);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'בוטל' where id = $1", [pC]));
    await allocate(await pay(1000, "2027-02-14", "cash", { contact: c }), iC, 1000);
    // E and F: plain invoices of 1 February paid on the 3rd (2 days) and the 21st (20 days)
    await allocate(await pay(1000, "2027-02-03", "cash", { contact: c }), await docOf(1000, "2027-02-01", "tax_invoice"), 1000);
    await allocate(await pay(1000, "2027-02-21", "cash", { contact: c }), await docOf(1000, "2027-02-01", "tax_invoice"), 1000);

    // the proformas are not counted; A, B, C, E, F are: 24, 11, 13, 2, 20 (a simple average, owner's answer (1) א)
    expect((await full(owner, "2027-02-01", "2027-02-28")).collection_days).toMatchObject({ documents: 5, average_days: 14, median_days: 13 });

    // opening-credit offsets settle the last part; their day is the day they were made in Asia/Jerusalem (UTC+2)
    const credit = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.opening_balance_set($1, $2, null, -1000, '2027-01-01') as id", [org, c])).id);
    const offset = async (document: string, at: string) => {
      const id = await run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.opening_credit_allocations (organization_id, credit_document_id, document_id, amount_agorot) values ($1, $2, $3, 500) returning id",
            [org, credit, document],
          )
        ).id,
      );
      // the time an offset was made is the server's (now()); the test moves it, past the row's guard trigger
      await asAdmin(async (q) => {
        await q("set local session_replication_role = replica");
        await q("update public.opening_credit_allocations set created_at = $2 where id = $1", [id, at]);
      });
    };
    // D5: invoice of 15 February, half paid on 20 February, the rest offset at 01:00 on 1 March local (28 February in UTC)
    const d5 = await docOf(1000, "2027-02-15", "tax_invoice");
    await allocate(await pay(500, "2027-02-20", "cash", { contact: c }), d5, 500);
    await offset(d5, "2027-02-28T23:00:00Z");
    // D4: invoice of 1 March, half paid on 10 March, the rest offset at 00:30 on 1 April local (31 March in UTC)
    const d4 = await docOf(1000, "2027-03-01", "tax_invoice");
    await allocate(await pay(500, "2027-03-10", "cash", { contact: c }), d4, 500);
    await offset(d4, "2027-03-31T22:30:00Z");

    // February keeps its five (D5's last day is 1 March); March holds D5 only (D4's last day is 1 April); April holds D4
    expect((await full(owner, "2027-02-01", "2027-02-28")).collection_days.documents).toBe(5);
    expect((await full(owner, "2027-03-01", "2027-03-31")).collection_days.documents).toBe(1);
    expect((await full(owner, "2027-04-01", "2027-04-30")).collection_days.documents).toBe(1);
    // D5 counts 14 days (15 February to 1 March): February and March together, 24 + 11 + 13 + 2 + 20 + 14 = 84 over 6
    expect((await full(owner, "2027-02-01", "2027-03-31")).collection_days).toMatchObject({ documents: 6, average_days: 14 });
  });

  it("rights: the PRM-01 key opens it, a member without it and a viewer get nothing; the keys; partial has no totals", async () => {
    expect(await report(member, "2026-08-01", "2026-09-30")).toEqual({ allowed: false });
    expect(await report(viewer, "2026-08-01", "2026-09-30")).toEqual({ allowed: false });
    expect((await full(keyHolder, "2026-08-01", "2026-09-30")).totals).toEqual({ amount: 62000, payments: 5 });
    expect((await full(manager, "2026-08-01", "2026-09-30")).partial).toBe(false);

    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const k = await full(keyHolder, "2026-08-01", "2026-09-30");
      expect(k.partial).toBe(true);
      expect(k.totals).toBeNull();
      // only the payments of the contact the key holder owns
      expect(k.by_method).toEqual([{ method: "credit", amount: 8000, payments: 1 }]);
      expect(k.by_rep).toEqual([{ owner_id: keyHolder.id, amount: 8000, payments: 1 }]);
      // no collection days in a partial view: an allocation the caller cannot read could hold the real last date
      expect(k.collection_days).toEqual({ min_documents: 5, documents: null, average_days: null, median_days: null, with_due_date: null, average_days_late: null, late_documents: null });
      const m = await full(manager, "2026-08-01", "2026-09-30");
      expect(m.partial).toBe(true);
      expect(m.totals).toBeNull();
      expect(m.by_rep.map((x) => x.owner_id)).toEqual([manager.id]);
      expect((await full(owner, "2026-08-01", "2026-09-30")).partial).toBe(false);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }

    for (const key of ["collection", "documents", "payments"]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, [key]: false })]));
      try {
        expect(await report(owner, "2026-08-01", "2026-09-30")).toEqual({ allowed: false });
        expect(await pgError(run(owner, (q) => q("select public.log_export($1, 'report', 'collection', 1, 'csv')", [org])))).toMatchObject({
          hint: key === "collection" ? "feature:collection" : "feature:payments",
        });
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
      }
    }
    await run(owner, (q) => q("select public.log_export($1, 'report', 'collection', 1, 'xlsx')", [org]));
    expect(REPORTS.find((x) => x.key === "collection")?.collection).toBe(true);
  });

  it("another business: its payments are never counted, and it sees nothing here", async () => {
    const stranger = await createUser("cr-stranger");
    const other = await createOrg(stranger.id, "עסק זר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify(FEATURES)]));
    await run(stranger, async (q) => {
      const c = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'זר') returning id", [other])).id;
      await q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 99999, '2026-09-05', 'cash')", [other, c]);
    });
    expect((await full(owner, "2026-08-01", "2026-09-30")).totals).toEqual({ amount: 62000, payments: 5 });
    expect(await run(stranger, async (q) => (await one<{ r: unknown }>(q, "select public.report_collection($1, '2026-08-01', '2026-09-30') as r", [org])).r)).toEqual({ allowed: false });
    // the owner asking about the other business gets nothing either
    expect(await run(owner, async (q) => (await one<{ r: unknown }>(q, "select public.report_collection($1, '2026-08-01', '2026-09-30') as r", [other])).r)).toEqual({ allowed: false });
  });

  it("is security invoker and closed to anon", async () => {
    const fn = await asAdmin(
      async (q) =>
        (
          await q<{ definer: boolean; anon: boolean; authed: boolean }>(
            `select p.prosecdef as definer, has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authed
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'report_collection'`,
          )
        ).rows,
    );
    expect(fn).toEqual([{ definer: false, anon: false, authed: true }]);
  });
});

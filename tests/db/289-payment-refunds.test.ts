import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * PAY-08 (owner's answer (71) ב, 3 November 2026): a refund is its own record on the payment; partial refunds are allowed and
 * reduce what the payment counts for everywhere; the payment row's facts never change; refunded in full = the payment's
 * status 'refunded'; allocations above what remains are released newest first; cancelling a refund gives the status back.
 */
describe("refunds of payments (PAY-08)", () => {
  let owner: U, admin: U, manager: U;
  let org: string;
  let pipelineId: string, stageId: string, wonStageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, collection: true, orders: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const contact = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const doc = (type: string, amount: number, contactId: string) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5) returning id", [
          org,
          contactId,
          type,
          `RF-${++n}`,
          amount,
        ])
      ).id,
    );
  const pay = (amount: number, contactId: string, paidOn = "2026-09-10", extra: { method?: string; order?: string | null } = {}) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, order_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, contactId, extra.order ?? null, amount, paidOn, extra.method ?? "transfer"],
        )
      ).id,
    );
  const allocate = (payment: string, document: string, amount: number) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4) returning id", [
          org,
          payment,
          document,
          amount,
        ])
      ).id,
    );
  const refund = (u: U, payment: string, amount: number, fields: { on?: string; doc?: string | null; reference?: string; note?: string } = {}) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payment_refunds (organization_id, payment_id, amount_agorot, refunded_on, method, credit_document_id, reference, note) values ($1, $2, $3, $4, 'transfer', $5, $6, $7) returning id",
          [org, payment, amount, fields.on ?? "2026-09-20", fields.doc ?? null, fields.reference ?? null, fields.note ?? null],
        )
      ).id,
    );
  const cancelRefund = (u: U, id: string, reason: string | null = "טעות") =>
    run(u, (q) => q("update public.payment_refunds set status = 'cancelled', cancel_reason = $2 where id = $1", [id, reason]));
  const payment = (id: string) =>
    run(owner, async (q) =>
      one<{ status: string; amount: number; counted: number; refunded: number; credit: number }>(
        q,
        "select p.status, p.amount_agorot::int as amount, public.payment_counted(p)::int as counted, public.payment_refunded(p)::int as refunded, public.payment_credit(p)::int as credit from public.payments p where p.id = $1",
        [id],
      ),
    );
  const stateCredit = (id: string) =>
    run(owner, async (q) => Number((await one<{ c: string }>(q, "select (public.money_allocation_state($1, '{}', array[$2]::uuid[]) -> 'payments' -> 0 ->> 'credit') as c", [org, id])).c));
  const liveAllocations = (paymentId: string) =>
    asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.payment_allocations where payment_id = $1 and released_at is null and removed_at is null order by created_at, id", [paymentId])).rows.map((r) => r.id),
    );
  const entries = (contactId: string) =>
    asAdmin(async (q) =>
      (await q<{ body: string; kind: string; created_by: string | null }>("select body, metadata ->> 'kind' as kind, created_by from public.activities where contact_id = $1 and type = 'system' order by created_at, id", [contactId])).rows,
    );

  beforeAll(async () => {
    owner = await createUser("rf-owner");
    org = await createOrg(owner.id, "עסק ההחזרים");
    admin = await addMember(org, owner.id, "admin", "rf-admin");
    manager = await addMember(org, owner.id, "manager", "rf-manager");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    const pipe = await asAdmin((q) =>
      one<{ p: string; s: string; w: string }>(
        q,
        `select p.id as p,
                (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'open' order by s.position limit 1) as s,
                (select s.id from public.stages s where s.pipeline_id = p.id and s.kind = 'won' order by s.position limit 1) as w
           from public.pipelines p where p.organization_id = $1 and p.is_default`,
        [org],
      ),
    );
    pipelineId = pipe.p;
    stageId = pipe.s;
    wonStageId = pipe.w;
  });

  it("a partial refund reduces what the payment counts and its credit; the row's facts and status stay", async () => {
    const c = await contact("רפאל");
    const p = await pay(10000, c);
    await refund(admin, p, 3000, { reference: "R-1" });
    expect(await payment(p)).toEqual({ status: "recorded", amount: 10000, counted: 7000, refunded: 3000, credit: 7000 });
    expect(await stateCredit(p)).toBe(7000);
    // the timeline says so, without an amount and without an author
    const last = (await entries(c)).at(-1)!;
    expect(last).toMatchObject({ kind: "payment_refunded", created_by: null });
    expect(last.body).toBe("הוחזר חלק מתשלום · העברה בנקאית");
    expect(last.body).not.toMatch(/\d/);
    // the kept credit total of the customer follows (PAY-03)
    const kept = await asAdmin(async (q) => Number((await one<{ v: string }>(q, "select coalesce(sum(credit_agorot), 0)::text as v from public.customer_credit_totals where contact_id = $1", [c])).v));
    expect(kept).toBe(7000);
  });

  it("never more than the payment holds, only on a recorded or confirmed payment, never before its day", async () => {
    const c = await contact("עדי");
    const p = await pay(5000, c);
    await refund(owner, p, 4000);
    expect((await pgError(refund(owner, p, 1001))).hint).toBe("refund:over");
    expect((await pgError(refund(owner, p, 500, { on: "2026-09-09" }))).hint).toBe("refund:date");
    const failed = await pay(5000, c);
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [failed]));
    expect((await pgError(refund(owner, failed, 1))).hint).toBe("refund:payment_state");
    // a manager records payments but does not refund
    expect((await pgError(refund(manager, p, 1))).code).toBe("42501");
  });

  it("a refund in full sets the payment refunded and releases its allocations; cancelling it gives the status back", async () => {
    const c = await contact("נועה");
    const invoice = await doc("tax_invoice", 6000, c);
    const p = await pay(6000, c);
    await run(owner, (q) => q("update public.payments set status = 'confirmed' where id = $1", [p]));
    await allocate(p, invoice, 6000);
    const r1 = await refund(owner, p, 2000);
    // what remains (4000) is below what is allocated (6000): the allocation is released, whole
    expect(await liveAllocations(p)).toEqual([]);
    expect((await payment(p)).credit).toBe(4000);
    const r2 = await refund(owner, p, 4000);
    expect(await payment(p)).toMatchObject({ status: "refunded", counted: 0, refunded: 6000, credit: 0 });
    expect((await entries(c)).at(-1)!.body).toBe("תשלום הוחזר · העברה בנקאית");
    // a refunded payment takes no allocation and no further refund
    expect((await pgError(allocate(p, invoice, 1))).hint).toBe("allocation:payment_state");
    expect((await pgError(refund(owner, p, 1))).hint).toBe("refund:payment_state");
    // cancelling: a reason is required; then the status the payment had comes back
    expect((await pgError(cancelRefund(admin, r2, " "))).hint).toBe("refund:cancel_reason");
    await cancelRefund(admin, r2, "הלקוח לא קיבל את ההחזר");
    expect(await payment(p)).toMatchObject({ status: "confirmed", counted: 4000, refunded: 2000 });
    const cancelEntry = (await entries(c)).at(-1)!;
    expect(cancelEntry.body).toBe("בוטל החזר לתשלום · העברה בנקאית · סיבה: הלקוח לא קיבל את ההחזר");
    // a cancelled refund is frozen; an active one is only cancelled
    expect((await pgError(run(owner, (q) => q("update public.payment_refunds set status = 'active', cancel_reason = null where id = $1", [r2]))))).toMatchObject({ code: "P0001" });
    expect((await pgError(run(owner, (q) => q("update public.payment_refunds set cancel_reason = 'x', status = 'active' where id = $1", [r1]))))).toMatchObject({ hint: "refund:frozen" });
    // released allocations stay released; the credit is what remains
    expect(await liveAllocations(p)).toEqual([]);
    expect((await payment(p)).credit).toBe(4000);
  });

  it("a partial refund releases the newest allocations first, only as far as needed", async () => {
    const c = await contact("גל");
    const a = await doc("tax_invoice", 3000, c);
    const b = await doc("tax_invoice", 3000, c);
    const d = await doc("tax_invoice", 3000, c);
    const p = await pay(10000, c);
    const first = await allocate(p, a, 3000);
    const second = await allocate(p, b, 3000);
    await allocate(p, d, 3000);
    // 9000 allocated of 10000; a refund of 3500 leaves 6500: the newest (d) goes, 6000 stay
    await refund(owner, p, 3500);
    expect(await liveAllocations(p)).toEqual([first, second]);
    expect((await payment(p)).credit).toBe(500);
    // no allocation beyond what the payment still holds
    expect((await pgError(allocate(p, d, 501))).hint).toBe("allocation:payment_over");
    await allocate(p, d, 500);
  });

  it("while refunds stand the payment keeps its status between recorded and confirmed, and its amount above them", async () => {
    const c = await contact("שי");
    const invoice = await doc("tax_invoice", 2000, c);
    const p = await pay(5000, c);
    await allocate(p, invoice, 2000);
    await refund(owner, p, 1000);
    await run(owner, (q) => q("update public.payments set status = 'confirmed' where id = $1", [p]));
    for (const sql of [
      "update public.payments set status = 'failed' where id = $1",
      "update public.payments set status = 'refunded' where id = $1",
      "update public.payments set status = 'cancelled', cancel_reason = 'x' where id = $1",
    ]) {
      expect((await pgError(run(owner, (q) => q(sql, [p])))).hint, sql).toBe("payment:has_refunds");
    }
    // below the refunds (a payment with nothing allocated), then below refunds + allocations
    const bare = await pay(4000, c);
    await refund(owner, bare, 3000);
    expect((await pgError(run(owner, (q) => q("update public.payments set amount_agorot = 2999 where id = $1", [bare])))).hint).toBe("payment:refunded_amount");
    expect((await pgError(run(owner, (q) => q("update public.payments set amount_agorot = 2999 where id = $1", [p])))).hint).toBe("payment:allocated");
    await run(owner, (q) => q("update public.payments set amount_agorot = 3000 where id = $1", [p]));
    expect(await payment(p)).toMatchObject({ counted: 2000, credit: 0 });
    // a cheque that bounces after a refund: cancel the refund first
    const cheque = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status) values ($1, $2, 4000, '2026-09-10', 'cheque', '100', '12', '123', '2026-09-30', 'cleared') returning id",
          [org, c],
        )
      ).id,
    );
    const r = await refund(owner, cheque, 4000);
    expect((await payment(cheque)).status).toBe("refunded");
    await cancelRefund(owner, r);
    // a cheque payment gets its status from its cheque
    expect((await payment(cheque)).status).toBe("confirmed");
    await refund(owner, cheque, 100);
    expect((await pgError(run(owner, (q) => q("update public.payments set cheque_status = 'bounced' where id = $1", [cheque])))).hint).toBe("payment:has_refunds");
  });

  it("a correction never takes a payment down to its refunds, nor changes one refunded in full (review)", async () => {
    const c = await contact("תיקון");
    const p = await pay(1000, c);
    await refund(owner, p, 300);
    // down to exactly the refunds would leave a recorded payment that counts 0
    expect((await pgError(run(owner, (q) => q("update public.payments set amount_agorot = 300 where id = $1", [p])))).hint).toBe("payment:refunded_amount");
    await run(owner, (q) => q("update public.payments set amount_agorot = 301 where id = $1", [p]));
    expect(await payment(p)).toMatchObject({ status: "recorded", counted: 1 });
    // refunded in full: no amount change either way (a raise would leave a surplus nobody counts)
    const full = await pay(500, c);
    await refund(owner, full, 500);
    expect((await payment(full)).status).toBe("refunded");
    for (const amount of [400, 600]) {
      expect((await pgError(run(owner, (q) => q("update public.payments set amount_agorot = $2 where id = $1", [full, amount])))).hint, String(amount)).toBe("payment:has_refunds");
    }
    // a payment its refunds took to nothing (only a server write can leave one recorded) is left off the statement
    const zero = await pay(700, c, new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    const shown = await pay(900, c, new Date(Date.now() - 86400000).toISOString().slice(0, 10));
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("insert into public.payment_refunds (organization_id, payment_id, amount_agorot, refunded_on, method) values ($1, $2, 700, current_date, 'cash')", [org, zero]);
    });
    expect(await payment(zero)).toMatchObject({ status: "recorded", counted: 0 });
    const view = await run(owner, async (q) =>
      (await one<{ v: { payments: { amount_agorot: number }[] } }>(q, "select public.statement_staff_view($1, $2, null) as v", [org, c])).v,
    );
    const amounts = view.payments.map((x) => x.amount_agorot);
    expect(amounts).toContain(900);
    expect(amounts.every((a) => a > 0)).toBe(true);
    expect(shown).toBeTruthy();
  });

  it("a cheque payment refunded in full and the refund cancelled takes its status from the cheque", async () => {
    const c = await contact("צ'קים");
    const cheque = (status: string) =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status) values ($1, $2, 2500, '2026-09-10', 'cheque', $3, '12', '123', '2026-10-30', $4) returning id",
            [org, c, String(500 + ++n), status],
          )
        ).id,
      );
    for (const [chequeStatus, back] of [
      ["in_hand", "recorded"],
      ["deposited", "recorded"],
      ["cleared", "confirmed"],
    ] as const) {
      const id = await cheque(chequeStatus);
      expect((await payment(id)).status, chequeStatus).toBe(back);
      const r = await refund(owner, id, 2500);
      expect(await payment(id), chequeStatus).toMatchObject({ status: "refunded", counted: 0, credit: 0 });
      // the cheque of a refunded payment does not change
      expect((await pgError(run(owner, (q) => q("update public.payments set cheque_status = 'cleared', status = 'confirmed' where id = $1", [id])))).code, chequeStatus).toBe("P0001");
      await cancelRefund(owner, r);
      expect(await payment(id), chequeStatus).toMatchObject({ status: back, counted: 2500, refunded: 0 });
      const cheq = await asAdmin(async (q) => (await one<{ s: string }>(q, "select cheque_status as s from public.payments where id = $1", [id])).s);
      expect(cheq).toBe(chequeStatus);
    }
  });

  it("names an active credit invoice of the same customer only", async () => {
    const c = await contact("דנה");
    const other = await contact("אחר");
    const p = await pay(3000, c);
    const credit = await doc("credit_invoice", 1000, c);
    const foreign = await doc("credit_invoice", 1000, other);
    const invoice = await doc("tax_invoice", 1000, c);
    for (const wrong of [foreign, invoice]) expect((await pgError(refund(owner, p, 100, { doc: wrong }))).hint).toBe("refund:credit_document");
    const r = await refund(owner, p, 1000, { doc: credit });
    expect(await asAdmin(async (q) => (await one<{ d: string }>(q, "select credit_document_id as d from public.payment_refunds where id = $1", [r])).d)).toBe(credit);
  });

  it("every reader of a payment's amount counts it less its refunds", async () => {
    const c = await contact("קרן");
    const p = await pay(10000, c, "2026-08-05");
    await refund(owner, p, 2500, { on: "2026-10-01" });
    // BAL-01: the ledger's payment line credits what counts
    const ledger = await run(owner, async (q) =>
      (await one<{ l: { lines: { kind: string; id: string; credit: number }[]; credit_balance: number } }>(q, "select public.customer_ledger($1, $2, null, '2026-01-01', '2026-12-31') as l", [org, c])).l,
    );
    expect(ledger.lines.find((l) => l.id === p)!.credit).toBe(7500);
    expect(ledger.credit_balance).toBe(7500);
    // COL-06 and GOL-01 collection (owner's answer (81) ב): the payment counts in full in its own month; the refund of
    // October is not in August
    const report = await run(owner, async (q) =>
      (await one<{ r: { by_month: { month: string; amount: number }[]; totals: { amount: number; refunds: number } } }>(q, "select public.report_collection($1, '2026-08-01', '2026-08-31') as r", [org])).r,
    );
    expect(report.totals).toMatchObject({ amount: 10000, refunds: 0 });
    await run(owner, (q) => q("insert into public.goals (organization_id, scope, period, period_start, metric, target) values ($1, 'org', 'month', '2026-08-01', 'collected', 1)", [org]));
    const goals = await run(owner, async (q) => (await one<{ r: { metric: string; actual: number }[] }>(q, "select public.report_goal_progress($1, 'month', '2026-08-01') as r", [org])).r);
    expect(goals.find((g) => g.metric === "collected")!.actual).toBe(10000);
    // BAL-04: the staff's statement view (the customer's page's own selection) lists the payment at what counts
    await run(owner, (q) => q("update public.payments set paid_on = current_date - 1 where id = $1", [p]));
    const view = await run(owner, async (q) =>
      (await one<{ v: { payments: { amount_agorot: number }[]; totals: { credit_agorot: number } } }>(q, "select public.statement_staff_view($1, $2, null) as v", [org, c])).v,
    );
    expect(view.payments.map((x) => x.amount_agorot)).toEqual([7500]);
    expect(view.totals.credit_agorot).toBe(7500);
  });

  it("collection report and goals: a payment in full in its month, each refund negative in the month it was made (81) ב", async () => {
    // a business of its own, so the months hold only these rows
    const o2 = await createOrg(owner.id, "עסק החזרים לפי חודש");
    const rep = await addMember(o2, owner.id, "member", "rf-rep");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o2, JSON.stringify({ ...FEATURES, granular_permissions: true, goals_per_rep: true })]));
    const c2 = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'חודשי', $2) returning id", [o2, owner.id])).id);
    const c3 = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'של הנציג', $2) returning id", [o2, rep.id])).id);
    const pay2 = (amount: number, contactId: string, on: string, method = "transfer") =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5) returning id", [
            o2,
            contactId,
            amount,
            on,
            method,
          ])
        ).id,
      );
    const refund2 = (payment: string, amount: number, on: string, method = "transfer") =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.payment_refunds (organization_id, payment_id, amount_agorot, refunded_on, method) values ($1, $2, $3, $4, $5) returning id", [
            o2,
            payment,
            amount,
            on,
            method,
          ])
        ).id,
      );
    type Row = { amount: number; payments: number; refunds: number; refund_count: number; net: number };
    const report = (from: string, to: string, ownerId: string | null = null) =>
      run(owner, async (q) =>
        (
          await one<{ r: { totals: Row | null; by_month: (Row & { month: string })[]; by_method: (Row & { method: string })[]; by_rep: (Row & { owner_id: string | null })[] } }>(
            q,
            "select public.report_collection($1, $2, $3, $4) as r",
            [o2, from, to, ownerId],
          )
        ).r,
      );
    const row = (amount: number, payments: number, refunds: number, refundCount: number) => ({ amount, payments, refunds, refund_count: refundCount, net: amount - refunds });

    // October: 10,000 by transfer refunded 3,000 in November; 4,000 in cash refunded IN FULL in November (by transfer);
    // 2,000 of the rep's contact refunded 500 in October and that refund cancelled; 1,500 marked refunded by hand (legacy)
    const p1 = await pay2(10000, c2, "2025-10-05");
    await refund2(p1, 3000, "2025-11-10");
    const p2 = await pay2(4000, c2, "2025-10-06", "cash");
    await refund2(p2, 4000, "2025-11-12");
    expect((await asAdmin(async (q) => one<{ s: string }>(q, "select status as s from public.payments where id = $1", [p2]))).s).toBe("refunded");
    const p3 = await pay2(2000, c3, "2025-10-07");
    const r3 = await refund2(p3, 500, "2025-10-20");
    await run(owner, (q) => q("update public.payment_refunds set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [r3]));
    const p4 = await pay2(1500, c2, "2025-10-08");
    await run(owner, (q) => q("update public.payments set status = 'refunded' where id = $1", [p4]));

    const both = await report("2025-10-01", "2025-11-30");
    expect(both.totals).toEqual(row(16000, 3, 7000, 2));
    expect(both.by_month).toEqual([
      { month: "2025-10-01", ...row(16000, 3, 0, 0) },
      { month: "2025-11-01", ...row(0, 0, 7000, 2) },
    ]);
    // a refund under its own method (the cash payment went back by transfer), under its payment's rep
    expect(both.by_method).toEqual([
      { method: "transfer", ...row(12000, 2, 7000, 2) },
      { method: "cash", ...row(4000, 1, 0, 0) },
    ]);
    expect(both.by_rep).toEqual([
      { owner_id: owner.id, ...row(14000, 2, 7000, 2) },
      { owner_id: rep.id, ...row(2000, 1, 0, 0) },
    ]);
    // October alone: the payments in full, the cancelled refund nowhere
    expect((await report("2025-10-01", "2025-10-31")).totals).toEqual(row(16000, 3, 0, 0));
    // November alone: refunds of payments from before the period count in it
    const nov = await report("2025-11-01", "2025-11-30");
    expect(nov.totals).toEqual(row(0, 0, 7000, 2));
    expect(nov.by_method).toEqual([{ method: "transfer", ...row(0, 0, 7000, 2) }]);
    // the rep filter follows the payment's rep
    expect((await report("2025-11-01", "2025-11-30", rep.id)).totals).toEqual(row(0, 0, 0, 0));
    expect((await report("2025-11-01", "2025-11-30", owner.id)).totals).toEqual(row(0, 0, 7000, 2));

    // GOL-01 collection: the same rule, by the payment's rep
    await run(owner, (q) =>
      q(
        `insert into public.goals (organization_id, scope, user_id, period, period_start, metric, target)
         values ($1, 'org', null, 'month', '2025-10-01', 'collected', 1), ($1, 'org', null, 'month', '2025-11-01', 'collected', 1),
                ($1, 'org', null, 'quarter', '2025-10-01', 'collected', 1), ($1, 'user', $2, 'month', '2025-11-01', 'collected', 1)`,
        [o2, owner.id],
      ),
    );
    const actual = async (period: string, start: string, scope = "org") =>
      (
        await run(owner, async (q) =>
          (await one<{ r: { metric: string; scope: string; actual: number }[] }>(q, "select public.report_goal_progress($1, $2, $3) as r", [o2, period, start])).r,
        )
      ).find((g) => g.metric === "collected" && g.scope === scope)?.actual;
    expect(await actual("month", "2025-10-01")).toBe(16000);
    expect(await actual("month", "2025-11-01")).toBe(-7000);
    expect(await actual("month", "2025-11-01", "user")).toBe(-7000);
    expect(await actual("quarter", "2025-10-01")).toBe(9000);
    // the refunds are counted rows: the definer count agrees with what the owner reads (the goal is shown)
    const counted = await run(owner, async (q) =>
      (
        await q<{ n: string }>(
          "select app.goal_payments_counted($1, g.id)::text as n from public.goals g where g.organization_id = $1 and g.scope = 'org' order by g.period, g.period_start",
          [o2],
        )
      ).rows.map((r) => Number(r.n)),
    );
    expect(counted).toEqual([3, 2, 5]);

    // a member with the payments key who reads only their own contact's payments: the November goal holds refunds of
    // payments they cannot read, so it is left out (not shown at a wrong figure); October's own rows are partial too
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [o2, rep.id]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [o2]));
    const repGoals = await run(rep, async (q) =>
      (await one<{ r: { metric: string; period_start: string; scope: string }[] }>(q, "select public.report_goal_progress($1, 'month', '2025-11-01') as r", [o2])).r,
    );
    expect(repGoals.filter((g) => g.metric === "collected" && g.scope === "org")).toEqual([]);
    const repReport = await run(rep, async (q) =>
      (await one<{ r: { partial: boolean; totals: Row | null; by_method: unknown[] } }>(q, "select public.report_collection($1, '2025-11-01', '2025-11-30') as r", [o2])).r,
    );
    expect(repReport.partial).toBe(true);
    expect(repReport.totals).toBeNull();
    expect(repReport.by_method).toEqual([]);
  });

  it("collection goals with refunds: a team goal, a cheque not yet due, a member's own goal while the wider goals stay hidden (81) ב", async () => {
    const o3 = await createOrg(owner.id, "עסק יעדי החזרים");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [o3, JSON.stringify({ ...FEATURES, granular_permissions: true, goals_per_rep: true })]));
    const rep1 = await addMember(o3, owner.id, "member", "rf-goal-rep1");
    const rep2 = await addMember(o3, owner.id, "member", "rf-goal-rep2");
    const team = await run(owner, async (q) => {
      const t = (await one<{ id: string }>(q, "insert into public.teams (organization_id, name) values ($1, 'צוות ההחזרים') returning id", [o3])).id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, false), ($1, $2, $4, false)", [o3, t, rep1.id, rep2.id]);
      return t;
    });
    const contactOf = (name: string, ownerId: string, teamId: string | null) =>
      run(owner, async (q) =>
        (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, team_id) values ($1, $2, $3, $4) returning id", [o3, name, ownerId, teamId])).id,
      );
    const c1 = await contactOf("של נציג 1", rep1.id, team);
    const c2 = await contactOf("של נציג 2", rep2.id, team);
    const c0 = await contactOf("של הבעלים", owner.id, null);
    const payOn = (contactId: string, amount: number, on: string, cheque: { due: string } | null = null) =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            cheque
              ? "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method, cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status) values ($1, $2, $3, $4, 'cheque', '9001', '12', '123', $5, 'in_hand') returning id"
              : "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, 'transfer') returning id",
            cheque ? [o3, contactId, amount, on, cheque.due] : [o3, contactId, amount, on],
          )
        ).id,
      );
    const refundOn = (payment: string, amount: number, on: string) =>
      run(owner, (q) => q("insert into public.payment_refunds (organization_id, payment_id, amount_agorot, refunded_on, method) values ($1, $2, $3, $4, 'transfer')", [o3, payment, amount, on]));

    // October: 5,000 of rep 1 (refunded 1,000 in November), 3,000 of rep 2 (refunded 500 in November), and a cheque of 2,000
    // on the owner's contact due long after today (refunded 700 in November)
    await refundOn(await payOn(c1, 5000, "2025-10-05"), 1000, "2025-11-03");
    await refundOn(await payOn(c2, 3000, "2025-10-06"), 500, "2025-11-04");
    const cheque = await payOn(c0, 2000, "2025-10-07", { due: "2099-12-31" });
    await refundOn(cheque, 700, "2025-11-05");

    await run(owner, (q) =>
      q(
        `insert into public.goals (organization_id, scope, user_id, team_id, period, period_start, metric, target)
         values ($1, 'org', null, null, 'month', '2025-10-01', 'collected', 1), ($1, 'org', null, null, 'month', '2025-11-01', 'collected', 1),
                ($1, 'team', null, $2, 'month', '2025-10-01', 'collected', 1), ($1, 'team', null, $2, 'month', '2025-11-01', 'collected', 1),
                ($1, 'user', $3, null, 'month', '2025-11-01', 'collected', 1)`,
        [o3, team, rep1.id],
      ),
    );
    const goals = (u: U, start: string) =>
      run(u, async (q) =>
        (await one<{ r: { metric: string; scope: string; actual: number }[] }>(q, "select public.report_goal_progress($1, 'month', $2) as r", [o3, start])).r.filter(
          (g) => g.metric === "collected",
        ),
      );
    const byScope = (rows: { scope: string; actual: number }[]) => Object.fromEntries(rows.map((g) => [g.scope, g.actual]));

    // the team goal nets its people's refunds in the refund's month; the cheque not yet due is out of every goal, with its
    // refund (the payment's cheque rule)
    expect(byScope(await goals(owner, "2025-10-01"))).toEqual({ org: 8000, team: 8000 });
    expect(byScope(await goals(owner, "2025-11-01"))).toEqual({ org: -1500, team: -1500, user: -1000 });
    // the collection report counts the cheque and its refund (it has no cheque rule)
    const r = await run(owner, async (q) =>
      (await one<{ r: { by_month: { month: string; amount: number; refunds: number }[] } }>(q, "select public.report_collection($1, '2025-10-01', '2025-11-30') as r", [o3])).r,
    );
    expect(r.by_month.map((m) => [m.month, m.amount, m.refunds])).toEqual([
      ["2025-10-01", 10000, 0],
      ["2025-11-01", 0, 2200],
    ]);
    // once the cheque is due, it and its refund count for the goals
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.payments set cheque_due_date = '2025-10-20' where id = $1", [cheque]);
    });
    expect(byScope(await goals(owner, "2025-10-01"))).toEqual({ org: 10000, team: 8000 });
    expect(byScope(await goals(owner, "2025-11-01"))).toEqual({ org: -2200, team: -1500, user: -1000 });

    // rep 1 records payments and reads only their own records: their own goal shows (with its refund); the business's and
    // the team's goals hold rows they cannot read (rep 2's and the owner's payments and refunds), so they stay hidden
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [o3, rep1.id]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [o3]));
    expect(byScope(await goals(rep1, "2025-11-01"))).toEqual({ user: -1000 });
    expect(byScope(await goals(rep1, "2025-10-01"))).toEqual({});
  });

  it("an order's payment counts less its refunds (ORD-02/04)", async () => {
    const c = await contact("אורי");
    const deal = await run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id) values ($1, 'הזמנה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          wonStageId ?? stageId,
          c,
        ])
      ).id,
    );
    await run(owner, (q) => q("insert into public.deal_lines (organization_id, deal_id, description, unit_price_agorot, quantity) values ($1, $2, 'עבודה', 10000, 1)", [org, deal]));
    const order = await run(owner, async (q) => (await one<{ id: string }>(q, "select public.order_from_deal($1, $2) as id", [org, deal])).id);
    const p = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, deal_id, order_id, amount_agorot, method) values ($1, $2, $3, 5000, 'transfer') returning id", [org, deal, order])).id,
    );
    const paid = async () =>
      run(owner, async (q) => (await one<{ s: { orders: { paid: number }[] } }>(q, "select public.order_money_state($1, array[$2]::uuid[]) as s", [org, order])).s.orders[0].paid);
    expect(await paid()).toBe(5000);
    await refund(owner, p, 1500, { on: new Date().toISOString().slice(0, 10) });
    expect(await paid()).toBe(3500);
  });

  it("a privacy erasure empties the refunds' reference, note and cancel reason, and erases their history", async () => {
    const c = await contact("למחיקה");
    const p = await pay(4000, c);
    const r1 = await refund(owner, p, 1000, { reference: "REF-1", note: "החזר לרפאל" });
    const r2 = await refund(owner, p, 500, { note: "שני" });
    await cancelRefund(owner, r2, "רפאל ביקש");
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [c]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [c]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, c]));
    const rows = await asAdmin(async (q) =>
      (await q<{ id: string; reference: string | null; note: string | null; cancel_reason: string | null; amount: number }>(
        "select id, reference, note, cancel_reason, amount_agorot::int as amount from public.payment_refunds where payment_id = $1 order by created_at", [p])).rows,
    );
    expect(rows).toEqual([
      { id: r1, reference: null, note: null, cancel_reason: null, amount: 1000 },
      { id: r2, reference: null, note: null, cancel_reason: "הסיבה נמחקה (מחיקת פרטיות)", amount: 500 },
    ]);
    const history = await asAdmin(async (q) =>
      (await q<{ changes: unknown }>("select changes from public.audit_log where entity_type = 'payment_refunds' and entity_id = any ($1::uuid[])", [[r1, r2]])).rows,
    );
    expect(history.length).toBeGreaterThan(0);
    for (const h of history) expect(h.changes).toEqual({ erased: true });
    // the amounts still count
    expect((await payment(p)).counted).toBe(3000);
  });
});

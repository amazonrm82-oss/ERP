import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Line = { kind: string; id: string; date: string; type: string; label: string | null; status: string; invoice_number: string | null; proforma_number: string | null; amount: number; debit: number; credit: number; balance: number };
type Ledger = {
  allowed: boolean;
  partial?: boolean;
  opening: number;
  shown_opening: number;
  truncated: boolean;
  debit: number;
  credit: number;
  closing: number;
  open_debt: number;
  credit_balance: number;
  lines: Line[];
};

/**
 * BAL-01: the customer's ledger, built as the owner answered: (1) א, (2) ב, (3) ב, (4) א, (5) א. Answer (3) ב: owners,
 * admins, managers and holders of `record_payments` open it; when a row of the customer is hidden from the user, only the
 * lines they read show, with partial: true and no balance of any kind.
 */
describe("customer ledger (BAL-01)", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, granular_permissions: true };

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
  const doc = (type: string, amount: number, date: string, on: { deal?: string | null; contact?: string | null }, proforma: string | null = null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, proforma_id) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
          [org, on.deal ?? null, on.contact ?? null, type, `LG-${++n}`, date, amount, proforma],
        )
      ).id,
    );
  const pay = (amount: number, date: string, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, 'transfer') returning id",
          [org, on.deal ?? null, on.contact ?? null, amount, date],
        )
      ).id,
    );
  const ledger = (u: U, where: { contact?: string | null; company?: string | null }, from = "2026-01-01", to = "2026-12-31") =>
    run(u, async (q) =>
      num(
        (await one<{ l: Ledger }>(q, "select public.customer_ledger($1, $2, $3, $4, $5) as l", [org, where.contact ?? null, where.company ?? null, from, to])).l,
      ),
    );
  // jsonb numbers arrive as numbers already; keep the shape typed
  const num = (l: Ledger): Ledger => l;
  const effects = (l: Ledger) => l.lines.map((x) => [x.type, Number(x.debit), Number(x.credit), Number(x.balance)]);

  beforeAll(async () => {
    owner = await createUser("lg-owner");
    org = await createOrg(owner.id, "עסק הכרטסת");
    admin = await addMember(org, owner.id, "admin", "lg-admin");
    manager = await addMember(org, owner.id, "manager", "lg-manager");
    member = await addMember(org, owner.id, "member", "lg-member");
    keyHolder = await addMember(org, owner.id, "member", "lg-key");
    viewer = await addMember(org, owner.id, "viewer", "lg-viewer");
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
  });

  it("debits, credits and a running balance by date; each type as decided; cancelled rows show with no effect", async () => {
    const a = await contact("אריאל");
    await doc("tax_invoice", 10000, "2026-03-01", { contact: a });
    await doc("tax_invoice_receipt", 3000, "2026-03-02", { contact: a });
    await doc("receipt", 2000, "2026-03-03", { contact: a });
    await pay(4000, "2026-03-04", { contact: a });
    await doc("credit_invoice", 1000, "2026-03-05", { contact: a });
    const cancelled = await doc("tax_invoice", 7000, "2026-03-06", { contact: a });
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    const failed = await pay(500, "2026-03-07", { contact: a });
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [failed]));
    const l = await ledger(owner, { contact: a });
    expect(l.allowed).toBe(true);
    expect(effects(l)).toEqual([
      ["tax_invoice", 10000, 0, 10000],
      ["tax_invoice_receipt", 3000, 3000, 10000],
      ["receipt", 0, 0, 10000],
      ["transfer", 0, 4000, 6000],
      ["credit_invoice", 0, 1000, 5000],
      ["tax_invoice", 0, 0, 5000],
      ["transfer", 0, 0, 5000],
    ]);
    expect(l.lines[5]).toMatchObject({ status: "cancelled", amount: 7000 });
    expect(l.lines[6]).toMatchObject({ status: "failed", amount: 500 });
    expect(l).toMatchObject({ opening: 0, debit: 13000, credit: 8000, closing: 5000, truncated: false });
    // open debt and credit are the documents' balances and PAY-03's credit (nothing is allocated here)
    expect(Number(l.open_debt)).toBe(10000);
    expect(Number(l.credit_balance)).toBe(4000);
  });

  it("a proforma is a debit from its own date and counts as billed only from the date of the invoice that bills it; the open debt follows the allocations", async () => {
    const numberOf = async (id: string) => (await asAdmin((q) => one<{ number: string }>(q, "select number from public.accounting_documents where id = $1", [id]))).number;
    const a = await contact("בתיה");
    const proforma = await doc("proforma", 5000, "2026-04-01", { contact: a });
    let l = await ledger(owner, { contact: a });
    expect(effects(l)).toEqual([["proforma", 5000, 0, 5000]]);
    const invoice = await doc("tax_invoice", 5000, "2026-04-10", { contact: a }, proforma);
    l = await ledger(owner, { contact: a });
    // the proforma keeps its debit; the invoice that takes over carries only the difference (none here)
    expect(effects(l)).toEqual([
      ["proforma", 5000, 0, 5000],
      ["tax_invoice", 0, 0, 5000],
    ]);
    expect(l.lines[0].invoice_number).toBe(await numberOf(invoice));
    expect(l.lines[1].proforma_number).toBe(await numberOf(proforma));
    // a period that ends before the invoice: the debt as it stood then, not yet billed
    const before = await ledger(owner, { contact: a }, "2026-01-01", "2026-04-05");
    expect(effects(before)).toEqual([["proforma", 5000, 0, 5000]]);
    expect(before.lines[0].invoice_number).toBeNull();
    expect(before.closing).toBe(5000);
    // a period that starts between them: the proforma in the opening, the invoice adds nothing more
    expect(await ledger(owner, { contact: a }, "2026-04-05", "2026-12-31")).toMatchObject({ opening: 5000, closing: 5000 });
    const p = await pay(2000, "2026-04-15", { contact: a });
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 2000)", [org, p, invoice]));
    l = await ledger(owner, { contact: a });
    expect(Number(l.closing)).toBe(3000);
    expect(Number(l.open_debt)).toBe(3000);
    expect(Number(l.credit_balance)).toBe(0);

    // an invoice larger or smaller than its proforma: the difference, as a debit or a credit
    const b = await contact("ברק");
    const small = await doc("proforma", 3000, "2026-06-01", { contact: b });
    await doc("tax_invoice", 3500, "2026-06-10", { contact: b }, small);
    const large = await doc("proforma", 3000, "2026-07-01", { contact: b });
    await doc("tax_invoice", 2000, "2026-07-10", { contact: b }, large);
    expect(effects(await ledger(owner, { contact: b }))).toEqual([
      ["proforma", 3000, 0, 3000],
      ["tax_invoice", 500, 0, 3500],
      ["proforma", 3000, 0, 6500],
      ["tax_invoice", 0, 1000, 5500],
    ]);
    // a cancelled invoice frees the proforma: it is a debit again, the cancelled invoice moves nothing
    const c = await contact("גאיה");
    const freed = await doc("proforma", 4000, "2026-08-01", { contact: c });
    const gone = await doc("tax_invoice", 4000, "2026-08-10", { contact: c }, freed);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [gone]));
    const lc = await ledger(owner, { contact: c });
    expect(effects(lc)).toEqual([
      ["proforma", 4000, 0, 4000],
      ["tax_invoice", 0, 0, 4000],
    ]);
    expect(lc.lines[0].invoice_number).toBeNull();
  });

  it("an invoice is netted only against a proforma that is a line of this ledger and dated on or before it", async () => {
    const dealOf = (contactId: string) =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה בלי חברה', $2, $3, $4, $5) returning id",
            [org, pipelineId, stageId, contactId, owner.id],
          )
        ).id,
      );
    // the proforma is on the deal only, outside the contact's ledger (PAY-02's proforma rule is wider): the invoice keeps
    // its full amount, and the closing balance equals the open debt
    const c = await contact("דורית");
    const d = await dealOf(c);
    const pf = await doc("proforma", 3000, "2026-03-01", { deal: d });
    await doc("tax_invoice", 5000, "2026-03-10", { deal: d, contact: c }, pf);
    const l = await ledger(owner, { contact: c });
    expect(l.partial).toBe(false);
    expect(effects(l)).toEqual([["tax_invoice", 5000, 0, 5000]]);
    expect(l.lines[0].proforma_number).toBeNull();
    expect(l).toMatchObject({ closing: 5000, open_debt: 5000 });

    // the reverse, pinned: the proforma is a line here, the invoice that bills it is outside (on the deal only). The
    // proforma stays a debit, while open_debt gives it no balance (its debt sits on that invoice, in another ledger)
    const c2 = await contact("הדס");
    const d2 = await dealOf(c2);
    const pf2 = await doc("proforma", 3000, "2026-04-01", { deal: d2, contact: c2 });
    const ti2 = await doc("tax_invoice", 4000, "2026-04-10", { deal: d2 }, pf2);
    const l2 = await ledger(owner, { contact: c2 });
    expect(effects(l2)).toEqual([["proforma", 3000, 0, 3000]]);
    expect(l2.lines[0].invoice_number).toBe((await asAdmin((q) => one<{ number: string }>(q, "select number from public.accounting_documents where id = $1", [ti2]))).number);
    expect(l2).toMatchObject({ closing: 3000, open_debt: 0 });

    // an invoice dated before its proforma: the invoice keeps its full amount, the proforma counts as billed from its own date
    const c3 = await contact("ורד");
    const late = await doc("proforma", 3000, "2026-05-10", { contact: c3 });
    await doc("tax_invoice", 5000, "2026-05-01", { contact: c3 }, late);
    expect(effects(await ledger(owner, { contact: c3 }))).toEqual([
      ["tax_invoice", 5000, 0, 5000],
      ["proforma", 0, 0, 5000],
    ]);
    // a period ending between the two dates: the invoice's whole amount, nothing subtracted
    expect(effects(await ledger(owner, { contact: c3 }, "2026-01-01", "2026-05-05"))).toEqual([["tax_invoice", 5000, 0, 5000]]);
    expect(await ledger(owner, { contact: c3 })).toMatchObject({ closing: 5000, open_debt: 5000 });
  });

  it("the period: an opening balance before it, rows after it left out; a missing or reversed period is refused", async () => {
    const a = await contact("גלעד");
    await doc("tax_invoice", 1000, "2025-12-15", { contact: a });
    await pay(300, "2025-12-20", { contact: a });
    await doc("tax_invoice", 500, "2026-02-01", { contact: a });
    await doc("tax_invoice", 9000, "2027-02-01", { contact: a });
    const l = await ledger(owner, { contact: a });
    expect(l).toMatchObject({ opening: 700, debit: 500, credit: 0, closing: 1200, shown_opening: 700 });
    expect(effects(l)).toEqual([["tax_invoice", 500, 0, 1200]]);
    // today's open debt counts every active document, whatever the period
    expect(Number(l.open_debt)).toBe(10500);
    expect((await pgError(ledger(owner, { contact: a }, "2026-05-01", "2026-04-01"))).hint).toBe("ledger:period");
    expect((await pgError(run(owner, (q) => q("select public.customer_ledger($1, $2, null, null, '2026-01-01')", [org, a])))).hint).toBe("ledger:period");
  });

  it("the customer is PAY-02's: a contact's ledger holds its company's other contacts and deals; the company's holds them all", async () => {
    const x = await company("חברת כרטסת");
    const a = await contact("דנה", x);
    const b = await contact("הדס", x);
    const d = await deal(null, x);
    await doc("tax_invoice", 1000, "2026-05-01", { contact: a });
    await doc("tax_invoice", 2000, "2026-05-02", { contact: b });
    await pay(500, "2026-05-03", { deal: d });
    const other = await contact("זר");
    await doc("tax_invoice", 9999, "2026-05-04", { contact: other });
    for (const where of [{ contact: a }, { contact: b }, { company: x }]) {
      const l = await ledger(owner, where);
      expect(Number(l.closing), JSON.stringify(where)).toBe(2500);
      expect(l.lines).toHaveLength(3);
    }
    expect(Number((await ledger(owner, { contact: other })).closing)).toBe(9999);
  });

  it("who opens it (answer 3 ב): owners, admins, managers and holders of record_payments; nobody else", async () => {
    const a = await contact("תפקידים");
    await doc("tax_invoice", 1000, "2026-07-01", { contact: a });
    for (const u of [owner, admin, manager, keyHolder]) {
      const l = await ledger(u, { contact: a });
      expect(l, u.email).toMatchObject({ allowed: true, partial: false, closing: 1000 });
    }
    for (const u of [member, viewer]) expect(await ledger(u, { contact: a }), u.email).toEqual({ allowed: false });
    // the key counts only while the plan has granular permissions (PRM-01)
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, granular_permissions: false })]));
    try {
      expect(await ledger(keyHolder, { contact: a })).toEqual({ allowed: false });
      expect((await ledger(manager, { contact: a })).allowed).toBe(true);
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
    const stranger = await createUser("lg-stranger");
    await createOrg(stranger.id, "עסק זר");
    expect(await ledger(stranger, { contact: a })).toEqual({ allowed: false });
    for (const off of ["balances", "documents", "payments"]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, [off]: false })]));
      expect(await ledger(owner, { contact: a }), off).toEqual({ allowed: false });
    }
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
  });

  describe("a row the user cannot read: the lines they read, partial, and no balance of any kind", () => {
    const PARTIAL_KEYS = ["allowed", "from", "lines", "partial", "to", "truncated"];
    const LINE_KEYS = ["amount", "credit", "date", "debit", "id", "invoice_number", "kind", "label", "proforma_number", "status", "type"];
    const expectPartial = (l: Ledger, lines: number) => {
      expect(l.allowed).toBe(true);
      expect(l.partial).toBe(true);
      expect(Object.keys(l).sort()).toEqual(PARTIAL_KEYS);
      expect(l.lines).toHaveLength(lines);
      for (const line of l.lines) expect(Object.keys(line).sort()).toEqual(LINE_KEYS);
    };

    beforeAll(() => asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org])));
    afterAll(() => asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org])));

    it("a hidden document in the period", async () => {
      const x = await company("חברה משותפת");
      const mine = await contact("של בעל המפתח", x, keyHolder.id);
      const theirs = await contact("של הבעלים", x);
      await doc("tax_invoice", 1000, "2026-06-01", { contact: mine });
      await doc("tax_invoice", 4000, "2026-06-02", { contact: theirs });
      const all = await ledger(owner, { contact: mine });
      expect(all).toMatchObject({ partial: false, closing: 5000 });
      const seen = await ledger(keyHolder, { contact: mine });
      expectPartial(seen, 1);
      expect(seen.lines[0]).toMatchObject({ kind: "document", debit: 1000, credit: 0, amount: 1000 });
      // the company's ledger is partial the same way
      expectPartial(await ledger(keyHolder, { company: x }), 1);
    });

    it("a hidden row only before the period, or only after it, or a payment on a hidden deal", async () => {
      const before = await contact("לפני", null, keyHolder.id);
      const y = await company("חברה לפני");
      const mine = await contact("שלי לפני", y, keyHolder.id);
      const hidden = await contact("מוסתר לפני", y);
      await doc("tax_invoice", 1000, "2026-03-01", { contact: mine });
      await doc("tax_invoice", 700, "2025-06-01", { contact: hidden });
      expectPartial(await ledger(keyHolder, { contact: mine }), 1);
      expect(await ledger(owner, { contact: mine })).toMatchObject({ partial: false, opening: 700, closing: 1700 });

      const z = await company("חברה אחרי");
      const mine2 = await contact("שלי אחרי", z, keyHolder.id);
      const hidden2 = await contact("מוסתר אחרי", z);
      await pay(300, "2026-02-01", { contact: mine2 });
      await doc("tax_invoice", 900, "2027-03-01", { contact: hidden2 });
      expectPartial(await ledger(keyHolder, { contact: mine2 }), 1);

      const w = await company("חברה עם עסקה");
      const mine3 = await contact("שלי עסקה", w, keyHolder.id);
      const hiddenDeal = await deal(null, w);
      await doc("tax_invoice", 1000, "2026-04-01", { contact: mine3 });
      await pay(400, "2026-04-02", { deal: hiddenDeal });
      expectPartial(await ledger(keyHolder, { contact: mine3 }), 1);

      // nothing hidden: the contact alone, all of it readable
      await doc("tax_invoice", 1200, "2026-05-01", { contact: before });
      await pay(200, "2026-05-02", { contact: before });
      expect(await ledger(keyHolder, { contact: before })).toEqual(await ledger(owner, { contact: before }));
    });

    it("an invoice the user reads is never netted against a proforma they cannot read", async () => {
      const x = await company("חברת חשבון עסקה");
      const mine = await contact("שלי חשבונית", x, keyHolder.id);
      const theirs = await contact("שלהם חשבון עסקה", x);
      const hiddenProforma = await doc("proforma", 3000, "2026-05-01", { contact: theirs });
      await doc("tax_invoice", 5000, "2026-05-10", { contact: mine }, hiddenProforma);
      const seen = await ledger(keyHolder, { contact: mine });
      expectPartial(seen, 1);
      expect(seen.lines[0]).toMatchObject({ type: "tax_invoice", debit: 5000, credit: 0, proforma_number: null });
      expect(await ledger(owner, { contact: mine })).toMatchObject({ partial: false, closing: 5000 });
    });

    it("known and accepted: a readable row reached only through a hidden contact of the company is called partial", async () => {
      // the user reads the document through a deal of theirs outside the company; its contact (in the company) is hidden.
      // The definer counts it in the customer, the user's scope does not reach it: partial, never a wrong balance or a leak.
      const x = await company("חברה עם איש קשר מוסתר");
      const mine = await contact("שלי בחברה", x, keyHolder.id);
      const hidden = await contact("מוסתר בחברה", x);
      const outside = await run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה שלי מחוץ לחברה', $2, $3, $4) returning id",
            [org, pipelineId, stageId, keyHolder.id],
          )
        ).id,
      );
      await doc("tax_invoice", 1000, "2026-06-01", { contact: mine });
      await doc("tax_invoice", 2000, "2026-06-02", { deal: outside, contact: hidden });
      expect(await run(keyHolder, async (q) => (await q("select 1 from public.accounting_documents where deal_id = $1", [outside])).rowCount)).toBe(1);
      expectPartial(await ledger(keyHolder, { contact: mine }), 1);
    });

    it("everything readable: every balance, equal to the owner's", async () => {
      const v = await company("חברה גלויה");
      const a = await contact("גלוי א", v, keyHolder.id);
      const b = await contact("גלוי ב", v, keyHolder.id);
      await doc("tax_invoice", 5000, "2025-11-01", { contact: a });
      await doc("tax_invoice", 3000, "2026-02-01", { contact: b });
      await pay(2500, "2026-02-10", { contact: a });
      const seen = await ledger(keyHolder, { company: v });
      expect(seen).toMatchObject({ allowed: true, partial: false, opening: 5000, debit: 3000, credit: 2500, closing: 5500, open_debt: 8000, credit_balance: 2500 });
      expect(seen.lines.every((x) => "balance" in x)).toBe(true);
      expect(seen).toEqual(await ledger(owner, { company: v }));
    });
  });

  it("the count behind partial is a number only, for those who may open a ledger, and never counts another business", async () => {
    const count = (u: U, o: string, c: string | null, co: string | null) =>
      run(u, async (q) => (await one<{ n: string | null }>(q, "select app.customer_money_rows($1, $2, $3) as n", [o, c, co])).n);
    const a = await contact("ספירה");
    await doc("tax_invoice", 100, "2026-01-05", { contact: a });
    await pay(100, "2026-01-06", { contact: a });
    expect(Number(await count(owner, org, a, null))).toBe(2);
    expect(Number(await count(keyHolder, org, a, null))).toBe(2);
    expect(await count(member, org, a, null)).toBeNull();
    expect(await count(viewer, org, a, null)).toBeNull();

    const other = await createUser("lg-other");
    const org2 = await createOrg(other.id, "עסק אחר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org2, JSON.stringify(FEATURES)]));
    const [c2, co2] = await run(other, async (q) => {
      const co = (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'זרה', $2) returning id", [org2, other.id])).id;
      const c = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, 'זר', $2, $3) returning id", [org2, co, other.id])).id;
      await q("insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'tax_invoice', 'X-1', '2026-01-01', 100)", [org2, c]);
      return [c, co];
    });
    expect(Number(await count(other, org2, c2, null))).toBe(1);
    // another business's ids in my business count nothing; another business's own count is not mine to read
    expect(Number(await count(owner, org, c2, co2))).toBe(0);
    expect(await count(owner, org2, c2, co2)).toBeNull();
    expect((await ledger(owner, { contact: c2, company: co2 })).lines).toHaveLength(0);
    expect((await ledger(owner, { contact: c2, company: co2 })).partial).toBe(false);

    const grants = await asAdmin((q) =>
      one<{ anon: boolean; auth: boolean; service: boolean; definer: boolean; config: string[] }>(
        q,
        `select has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as auth,
                has_function_privilege('service_role', p.oid, 'execute') as service, p.prosecdef as definer, p.proconfig as config
           from pg_proc p where p.oid = 'app.customer_money_rows(uuid, uuid, uuid)'::regprocedure`,
      ),
    );
    expect(grants).toEqual({ anon: false, auth: true, service: false, definer: true, config: ['search_path=""'] });
  });

  it("at most 500 lines: the latest ones, opening at the balance before them", async () => {
    const a = await contact("הרבה");
    await asAdmin((q) =>
      q(
        `insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot)
         select $1, $2, 'tax_invoice', 'BULK-' || g, date '2026-01-01' + (g % 300), 100 from generate_series(1, 520) g`,
        [org, a],
      ),
    );
    const l = await ledger(owner, { contact: a });
    expect(l.truncated).toBe(true);
    expect(l.lines).toHaveLength(500);
    expect(Number(l.shown_opening)).toBe(2000);
    expect(Number(l.lines[0].balance)).toBe(2100);
    expect(Number(l.lines[499].balance)).toBe(52000);
    expect(Number(l.closing)).toBe(52000);
  });
});

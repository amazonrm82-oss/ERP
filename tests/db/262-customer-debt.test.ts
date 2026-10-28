import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Summary = {
  allowed: boolean;
  partial?: boolean;
  today?: string;
  open_debt?: number;
  open_documents?: number;
  overdue_debt?: number;
  overdue_documents?: number;
  oldest_due_date?: string | null;
};

/**
 * BAL-02: the customer's open debt and overdue debt. One rule (public.money_allocation_state's balances of active tax
 * invoices, proformas and positive opening balances; overdue = due before the business's today), PAY-02's customer (a
 * contact without a company = its own documents; a contact with a company = the company's), shown on the card under RLS
 * with BAL-01's rights and partial rule, and kept by the server for the lists (owners and admins only).
 */
describe("customer debt (BAL-02)", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, granular_permissions: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  // calendar days of the business (Asia/Jerusalem), as the SQL counts them; a UTC date is a day behind
  // between midnight in Israel and midnight UTC
  const day = (offset: number) =>
    new Date(Date.now() + offset * 86_400_000).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
  const company = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const contact = (name: string, companyId: string | null = null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, ownerId])).id,
    );
  const deal = (contactId: string | null, companyId: string | null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, company_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5, $6) returning id",
          [org, pipelineId, stageId, contactId, companyId, ownerId],
        )
      ).id,
    );
  const doc = (type: string, amount: number, due: string | null, on: { deal?: string | null; contact?: string | null }, proforma: string | null = null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date, proforma_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
          [org, on.deal ?? null, on.contact ?? null, type, `DB-${++n}`, day(-120), amount, due, proforma],
        )
      ).id,
    );
  const pay = (amount: number, on: { deal?: string | null; contact?: string | null }) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, 'transfer') returning id",
          [org, on.deal ?? null, on.contact ?? null, amount, day(-1)],
        )
      ).id,
    );
  const allocate = (payment: string, document: string, amount: number) =>
    run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, payment, document, amount]));
  const summary = (u: U, where: { contact?: string | null; company?: string | null }) =>
    run(u, async (q) => (await one<{ s: Summary }>(q, "select public.customer_debt_summary($1, $2, $3) as s", [org, where.contact ?? null, where.company ?? null])).s);
  const listed = (u: U, table: "contacts" | "companies", id: string) =>
    run(u, (q) =>
      one<{ open: string | null; overdue: string | null; has_debt: boolean; has_overdue: boolean }>(
        q,
        `select public.debt_balance(t) as open, public.overdue_debt(t) as overdue, public.has_debt(t) as has_debt, public.has_overdue_debt(t) as has_overdue
           from public.${table} t where t.id = $1`,
        [id],
      ),
    );
  const ledgerDebt = (u: U, where: { contact?: string | null; company?: string | null }) =>
    run(u, async (q) =>
      Number(
        (await one<{ l: { open_debt: number } }>(q, "select public.customer_ledger($1, $2, $3, '2020-01-01', $4) as l", [org, where.contact ?? null, where.company ?? null, day(0)]))
          .l.open_debt,
      ),
    );
  const figures = (s: Summary) => [Number(s.open_debt), Number(s.overdue_debt), Number(s.open_documents), Number(s.overdue_documents)];
  const nums = (r: { open: string | null; overdue: string | null }) => [r.open === null ? null : Number(r.open), r.overdue === null ? null : Number(r.overdue)];

  beforeAll(async () => {
    owner = await createUser("db-owner");
    org = await createOrg(owner.id, "עסק החובות");
    admin = await addMember(org, owner.id, "admin", "db-admin");
    manager = await addMember(org, owner.id, "manager", "db-manager");
    member = await addMember(org, owner.id, "member", "db-member");
    keyHolder = await addMember(org, owner.id, "member", "db-key");
    viewer = await addMember(org, owner.id, "viewer", "db-viewer");
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

  it("a contact without a company: open and overdue debt, the card, the list and the ledger agree", async () => {
    const a = await contact("אביגיל");
    const late = await doc("tax_invoice", 10000, day(-40), { contact: a });
    await doc("tax_invoice", 5000, day(10), { contact: a });
    // due today is not overdue yet
    await doc("tax_invoice", 700, day(0), { contact: a });
    // a proforma billed by an invoice carries nothing; the invoice carries the rest once
    const proforma = await doc("proforma", 3000, day(-5), { contact: a });
    await doc("tax_invoice", 3000, day(-3), { contact: a }, proforma);
    // credit invoices, receipts and invoice-receipts are never debt
    await doc("credit_invoice", 900, null, { contact: a });
    await doc("tax_invoice_receipt", 800, null, { contact: a });
    const p = await pay(4000, { contact: a });
    await allocate(p, late, 4000);

    const s = await summary(owner, { contact: a });
    expect(s).toMatchObject({ allowed: true, partial: false });
    // 6000 + 5000 + 700 + 3000 open; overdue: 6000 (due 40 days ago) + 3000 (the invoice billing the proforma, 3 days ago)
    expect(figures(s)).toEqual([14700, 9000, 4, 2]);
    expect(s.oldest_due_date).toBe(day(-40));
    expect(await ledgerDebt(owner, { contact: a })).toBe(14700);
    expect(nums(await listed(owner, "contacts", a))).toEqual([14700, 9000]);
    expect(await listed(admin, "contacts", a)).toMatchObject({ has_debt: true, has_overdue: true });
  });

  it("follows allocations, a failed payment, a cancelled document and a changed due date", async () => {
    const b = await contact("ברק");
    const inv = await doc("tax_invoice", 8000, day(-20), { contact: b });
    const p = await pay(8000, { contact: b });
    await allocate(p, inv, 8000);
    expect(nums(await listed(owner, "contacts", b))).toEqual([0, 0]);
    expect(await listed(owner, "contacts", b)).toMatchObject({ has_debt: false, has_overdue: false });
    // a failed payment releases its allocation: the debt is back
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [p]));
    expect(nums(await listed(owner, "contacts", b))).toEqual([8000, 8000]);
    // a later due date: still owed, no longer overdue
    await run(owner, (q) => q("update public.accounting_documents set due_date = $2 where id = $1", [inv, day(30)]));
    expect(nums(await listed(owner, "contacts", b))).toEqual([8000, 0]);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [inv]));
    expect(nums(await listed(owner, "contacts", b))).toEqual([0, 0]);
    expect(figures(await summary(owner, { contact: b }))).toEqual([0, 0, 0, 0]);
  });

  it("a company: its opening balance, its contacts' and deals' documents; a contact of it shows the company's figures", async () => {
    const co = await company("חברת החוב");
    const c1 = await contact("גלית", co);
    const c2 = await contact("דן", co);
    const d = await deal(null, co);
    await doc("tax_invoice", 1000, day(-100), { contact: c1 });
    await doc("proforma", 2000, day(-50), { deal: d });
    await run(owner, (q) => q("select public.opening_balance_set($1, null, $2, 4000, $3, $4)", [org, co, day(-200), day(-70)]));
    const expected = [7000, 7000];
    expect(nums(await listed(owner, "companies", co))).toEqual(expected);
    expect(nums(await listed(owner, "contacts", c2))).toEqual(expected);
    expect(figures(await summary(owner, { company: co }))).toEqual([7000, 7000, 3, 3]);
    expect(figures(await summary(owner, { contact: c2 }))).toEqual([7000, 7000, 3, 3]);
    expect(await ledgerDebt(owner, { company: co })).toBe(7000);

    // c1 leaves the company: its invoice leaves the company's total and is its own again
    await run(owner, (q) => q("update public.contacts set company_id = null where id = $1", [c1]));
    expect(nums(await listed(owner, "companies", co))).toEqual([6000, 6000]);
    expect(nums(await listed(owner, "contacts", c1))).toEqual([1000, 1000]);
    // the deal leaves the company too
    await run(owner, (q) => q("update public.deals set company_id = null where id = $1", [d]));
    expect(nums(await listed(owner, "companies", co))).toEqual([4000, 4000]);
  });

  it("overdue is judged in the business's time zone", async () => {
    const e = await contact("הדס");
    await doc("tax_invoice", 1200, day(-1), { contact: e });
    const yesterdayOverdue = nums(await listed(owner, "contacts", e));
    expect(yesterdayOverdue).toEqual([1200, 1200]);
    // a zone far ahead or behind moves "today" by at most a day; a document due tomorrow by UTC is never overdue
    const f = await contact("ורד");
    await doc("tax_invoice", 300, day(2), { contact: f });
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
      expect(nums(await listed(owner, "contacts", f))).toEqual([300, 0]);
    }
    await asAdmin((q) => q("update public.organizations set timezone = 'Asia/Jerusalem' where id = $1", [org]));
  });

  it("the card follows BAL-01's rights; the list columns are for owners and admins only", async () => {
    const g = await contact("זיו");
    await doc("tax_invoice", 2500, day(-10), { contact: g });
    for (const u of [owner, admin, manager, keyHolder]) {
      expect(figures(await summary(u, { contact: g })), u.email).toEqual([2500, 2500, 1, 1]);
    }
    expect(await summary(member, { contact: g })).toEqual({ allowed: false });
    expect(await summary(viewer, { contact: g })).toEqual({ allowed: false });
    for (const u of [manager, member, keyHolder, viewer]) {
      expect(await listed(u, "contacts", g), u.email).toEqual({ open: null, overdue: null, has_debt: false, has_overdue: false });
    }
    // the server-kept rows and totals: owners and admins read them, nobody writes them
    const read = (u: U) =>
      run(u, async (q) => [
        (await q("select 1 from public.customer_debt_totals where contact_id = $1", [g])).rowCount,
        (await q("select 1 from public.debt_document_customers where contact_id = $1", [g])).rowCount,
      ]);
    expect(await read(admin)).toEqual([1, 1]);
    expect(await read(manager)).toEqual([0, 0]);
    for (const sql of [
      "update public.customer_debt_totals set open_agorot = 1 where contact_id = $1",
      "delete from public.customer_debt_totals where contact_id = $1",
      "update public.debt_document_customers set balance_agorot = 1 where contact_id = $1",
      "delete from public.debt_document_customers where contact_id = $1",
    ]) {
      expect((await pgError(run(owner, (q) => q(sql, [g])))).code, sql).toBe("42501");
    }
  });

  it("partial: a key holder who cannot read every row of the customer sees no figure", async () => {
    const co = await company("חברה חלקית");
    const mine = await contact("חן", co, keyHolder.id);
    // a deal of the company owned by someone else, on a business whose records are read by their owners only
    const hidden = await deal(null, co, owner.id);
    await doc("tax_invoice", 9000, day(-15), { deal: hidden });
    await doc("tax_invoice", 1000, day(-15), { contact: mine });
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await summary(keyHolder, { contact: mine })).toEqual({ allowed: true, partial: true });
      expect(figures(await summary(owner, { contact: mine }))).toEqual([10000, 10000, 2, 2]);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("without any of the plan keys the card is closed and the list values are null", async () => {
    const h = await contact("טל");
    await doc("tax_invoice", 400, day(-2), { contact: h });
    expect(nums(await listed(owner, "contacts", h))).toEqual([400, 400]);
    for (const key of ["balances", "documents", "payments"]) {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, [key]: false })]));
      try {
        expect(await summary(owner, { contact: h }), key).toEqual({ allowed: false });
        expect(await listed(owner, "contacts", h), key).toEqual({ open: null, overdue: null, has_debt: false, has_overdue: false });
      } finally {
        await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
      }
    }
  });

  it("the documents trigger watches only the columns that move a balance; totals stay right through them", async () => {
    const cols = await asAdmin(
      async (q) =>
        (
          await q<{ c: string }>(
            `select a.attname as c from pg_trigger t join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr)
              where t.tgrelid = 'public.accounting_documents'::regclass and t.tgname = 'accounting_documents_customer_debt' order by 1`,
          )
        ).rows.map((r) => r.c),
    );
    expect(cols).toEqual(["amount_agorot", "company_id", "contact_id", "deal_id", "doc_type", "due_date", "proforma_id", "status"]);

    const co = await company("חברת המעבר");
    const k = await contact("כנרת", co);
    // a receipt, a credit invoice and an invoice-receipt never make debt rows
    for (const type of ["receipt", "credit_invoice", "tax_invoice_receipt"]) await doc(type, 500, null, { contact: k });
    expect(
      await asAdmin(async (q) =>
        Number((await one<{ n: string }>(q, "select count(*) as n from public.debt_document_customers r join public.accounting_documents d on d.id = r.document_id where d.contact_id = $1", [k])).n),
      ),
    ).toBe(0);
    // a proforma, then the invoice that bills it: the debt is counted once, on the invoice
    const pro = await doc("proforma", 3000, day(-20), { contact: k });
    expect(nums(await listed(owner, "companies", co))).toEqual([3000, 3000]);
    const inv = await doc("tax_invoice", 3500, day(5), { contact: k }, pro);
    expect(nums(await listed(owner, "companies", co))).toEqual([3500, 0]);
    // cancelling the invoice frees the proforma: owed again
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [inv]));
    expect(nums(await listed(owner, "companies", co))).toEqual([3000, 3000]);
    // a purge of the contact: the document's contact is set null by the FK, so it leaves the company's total
    await asAdmin((q) => q("delete from public.contacts where id = $1", [k]));
    expect(nums(await listed(owner, "companies", co))).toEqual([0, 0]);
  });

  it("another business sees nothing", async () => {
    const i = await contact("יעל");
    await doc("tax_invoice", 600, day(-3), { contact: i });
    const stranger = await createUser("db-stranger");
    await createOrg(stranger.id, "עסק זר");
    expect(await summary(stranger, { contact: i })).toEqual({ allowed: false });
    expect((await run(stranger, (q) => q("select public.debt_balance(t) from public.contacts t where t.id = $1", [i]))).rowCount).toBe(0);
    expect(await asAdmin(async (q) => Number((await one<{ n: string }>(q, "select count(*) as n from public.customer_debt_totals where contact_id = $1", [i])).n))).toBe(1);
    expect(
      await run(stranger, async (q) => (await q("select app.customer_debt_of($1, null, $2, false) as v", [org, i])).rows[0].v),
    ).toBeNull();
  });

  it("is invoker for the card, definer only for the kept value; closed to anon", async () => {
    const fns = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; definer: boolean; anon: boolean; authed: boolean }>(
            `select n.nspname || '.' || p.proname as name, p.prosecdef as definer,
                    has_function_privilege('anon', p.oid, 'execute') as anon,
                    has_function_privilege('authenticated', p.oid, 'execute') as authed
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname in ('customer_debt_summary', 'debt_balance', 'overdue_debt', 'has_debt', 'has_overdue_debt'))
                 or (n.nspname = 'app' and p.proname in ('customer_debt_of', 'debt_document_sync', 'customer_debt_refresh'))
              order by 1, 2`,
          )
        ).rows,
    );
    for (const f of fns) {
      expect(f.anon, f.name).toBe(false);
      if (f.name === "app.debt_document_sync" || f.name === "app.customer_debt_refresh") {
        expect(f).toMatchObject({ definer: true, authed: false });
      } else if (f.name === "app.customer_debt_of") {
        expect(f).toMatchObject({ definer: true, authed: true });
      } else {
        expect(f, f.name).toMatchObject({ definer: false, authed: true });
      }
    }
  });
});

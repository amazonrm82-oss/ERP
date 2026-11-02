import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type View = Record<string, unknown> & {
  allowed: boolean;
  partial?: boolean;
  refused?: string;
  bank?: Record<string, unknown> | null;
  bank_elsewhere?: boolean;
  built_with?: boolean;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BANK = { bank_name: "בנק הצוות", bank_branch: "321", bank_account: "55443322", bank_account_name: "צוות בע\"מ" };

/**
 * BAL-04 (owner, 2 November 2026, answers (35) א and (36) ב): the staff's statement PDF holds exactly what the customer's page
 * holds. public.statement_staff_view (security invoker, the user's session) answers public.statement_public's content for one
 * customer under BAL-01's rights, keys and partial rule; the bank details only for owners and admins while the statement's
 * switch is on, otherwise `bank_elsewhere` (the PDF prints a line in their place).
 */
describe("the staff's statement view (BAL-04)", () => {
  let owner: U, admin: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, granular_permissions: true };

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const day = (offset: number) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const company = (name: string, u: U = owner) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [org, name, u.id])).id);
  const contact = (name: string, companyId: string | null = null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, $2, $3, $4) returning id", [org, name, companyId, ownerId])).id,
    );
  const deal = (companyId: string | null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, company_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id",
          [org, pipelineId, stageId, companyId, ownerId],
        )
      ).id,
    );
  const doc = (type: string, amount: number, due: string | null, on: { deal?: string | null; contact?: string | null }, proforma: string | null = null) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date, proforma_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
          [org, on.deal ?? null, on.contact ?? null, type, `SV-${++n}`, day(-60), amount, due, proforma],
        )
      ).id,
    );
  const pay = (amount: number, on: { deal?: string | null; contact?: string | null }, paidOn = day(-1), method = "transfer") =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, $4, $5, $6) returning id",
          [org, on.deal ?? null, on.contact ?? null, amount, paidOn, method],
        )
      ).id,
    );
  const allocate = (payment: string, document: string, amount: number) =>
    run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, $4)", [org, payment, document, amount]));
  const view = (u: U, where: { contact?: string; company?: string }) =>
    run(u, async (q) => (await one<{ v: View }>(q, "select public.statement_staff_view($1, $2, $3) as v", [org, where.contact ?? null, where.company ?? null])).v);
  const publicPage = async (where: { contact?: string; company?: string }) => {
    const token = await run(owner, async (q) => (await one<{ t: string }>(q, "select public.statement_link_create($1, $2, $3) as t", [org, where.contact ?? null, where.company ?? null])).t);
    return asService(async (q) => (await one<{ p: Record<string, unknown> }>(q, "select public.statement_public($1, null) as p", [token])).p);
  };
  // the staff answer without its own keys
  const content = (v: View) => {
    const rest: Record<string, unknown> = { ...v };
    for (const key of ["allowed", "partial", "bank_elsewhere", "built_with"]) delete rest[key];
    return rest;
  };
  const withoutBuiltWith = (p: Record<string, unknown>) => {
    const rest = { ...p };
    delete rest.built_with;
    return rest;
  };

  beforeAll(async () => {
    owner = await createUser("sv-owner");
    org = await createOrg(owner.id, "עסק הצוות");
    admin = await addMember(org, owner.id, "admin", "sv-admin");
    member = await addMember(org, owner.id, "member", "sv-member");
    keyHolder = await addMember(org, owner.id, "member", "sv-key");
    viewer = await addMember(org, owner.id, "viewer", "sv-viewer");
    outsider = await createUser("sv-outsider");
    otherOrg = await createOrg(outsider.id, "עסק זר");
    await setFeatures(FEATURES);
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
    await run(owner, (q) =>
      q(
        `insert into public.org_document_settings (organization_id, vat_status, legal_name, tax_id, phone) values ($1, 'licensed', 'הצוות בע"מ', '515555555', '03-5551111')
         on conflict (organization_id) do update set legal_name = excluded.legal_name, phone = excluded.phone`,
        [org],
      ),
    );
    await run(owner, (q) =>
      q(
        "insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account, bank_account_name) values ($1, $2, $3, $4, $5)",
        [org, BANK.bank_name, BANK.bank_branch, BANK.bank_account, BANK.bank_account_name],
      ),
    );
  });

  it("equals the customer's page for the same customer (a company and a contact without one), for owners and admins", async () => {
    const co = await company("חברת הצוות");
    const c1 = await contact("מיכל", co);
    const d = await deal(co);
    const inv = await doc("tax_invoice", 10000, day(-12), { contact: c1 });
    await doc("tax_invoice", 4000, day(6), { deal: d });
    const pro = await doc("proforma", 3000, day(-4), { deal: d });
    await doc("tax_invoice", 3000, day(-1), { deal: d }, pro);
    await run(owner, (q) => q("select public.opening_balance_set($1, null, $2, 2500, $3, $4)", [org, co, day(-300), day(-90)]));
    const p1 = await pay(6000, { contact: c1 });
    await allocate(p1, inv, 6000);
    // credit paid in cash, a payment older than 12 months (not listed) and a cancelled one (not listed)
    await pay(900, { deal: d }, day(-20), "cash");
    await pay(1200, { contact: c1 }, day(-400));
    const cancelled = await pay(700, { contact: c1 }, day(-2));
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));

    const solo = await contact("נעמה");
    await doc("tax_invoice", 5000, day(-3), { contact: solo });
    await pay(800, { contact: solo }, day(-5));

    for (const where of [{ company: co }, { contact: solo }]) {
      const page = withoutBuiltWith(await publicPage(where));
      for (const u of [owner, admin]) {
        const v = await view(u, where);
        expect(v.allowed, u.email).toBe(true);
        expect(v.partial, u.email).toBe(false);
        expect(v.bank_elsewhere, u.email).toBe(false);
        expect(content(v), u.email).toEqual(page);
      }
    }
    const v = await view(owner, { company: co });
    expect(v.bank).toEqual(BANK);
    expect(JSON.stringify(content(v))).not.toMatch(UUID);
    expect((v.payments as unknown[]).length).toBe(2);
    expect((v.documents as unknown[]).length).toBe(4);
  });

  it("a payment recorder who is not an admin gets the content without the bank details; nobody else gets anything", async () => {
    const e = await contact("אסנת");
    await doc("tax_invoice", 2000, day(-1), { contact: e });
    const page = withoutBuiltWith(await publicPage({ contact: e }));
    const v = await view(keyHolder, { contact: e });
    expect(v.allowed).toBe(true);
    expect(v.bank).toBeNull();
    expect(v.bank_elsewhere).toBe(true);
    expect(JSON.stringify(v)).not.toContain(BANK.bank_account);
    expect({ ...content(v), bank: page.bank }).toEqual(page);

    for (const u of [member, viewer, outsider]) expect(await view(u, { contact: e }), u.email).toEqual({ allowed: false });
    expect((await pgError(asAnon((q) => q("select public.statement_staff_view($1, $2, null)", [org, e])))).code).toBe("42501");
    // exactly one customer
    expect((await pgError(view(owner, {}))).code).toBe("22023");
  });

  it("an admin gets the details while the statement's switch is on and the line while it is off", async () => {
    const f = await contact("פזית");
    await doc("tax_invoice", 1500, day(2), { contact: f });
    await run(owner, (q) =>
      q("insert into public.quote_designs (organization_id, show_bank_details_statement) values ($1, false) on conflict (organization_id) do update set show_bank_details_statement = false", [org]),
    );
    try {
      for (const u of [owner, admin]) {
        const v = await view(u, { contact: f });
        expect(v.bank, u.email).toBeNull();
        expect(v.bank_elsewhere, u.email).toBe(true);
      }
    } finally {
      await run(owner, (q) => q("update public.quote_designs set show_bank_details_statement = true where organization_id = $1", [org]));
    }
    const on = await view(admin, { contact: f });
    expect(on.bank).toEqual(BANK);
    expect(on.bank_elsewhere).toBe(false);
  });

  it("refuses a partial view, a contact of a company, a binned or unknown customer and missing keys", async () => {
    // a key holder who cannot read a deal of the company (visibility own): partial, nothing else
    const part = await company("חברה חלקית", keyHolder);
    await contact("רוני", part, keyHolder.id);
    const hidden = await deal(part, owner.id);
    await doc("tax_invoice", 9000, day(-15), { deal: hidden });
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await view(keyHolder, { company: part })).toEqual({ allowed: true, partial: true });
      // a customer the key holder does not read at all is not found
      const notMine = await contact("ורד");
      expect(await view(keyHolder, { contact: notMine })).toEqual({ allowed: true, partial: false, refused: "not_found" });
      expect((await view(owner, { company: part })).partial).toBe(false);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }

    const co = await company("חברת אם");
    const inCo = await contact("בני", co);
    expect(await view(owner, { contact: inCo })).toEqual({ allowed: true, partial: false, refused: "company" });
    const binned = await contact("גילה");
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    expect(await view(owner, { contact: binned })).toEqual({ allowed: true, partial: false, refused: "not_found" });
    const theirs = await run(outsider, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [otherOrg, outsider.id])).id,
    );
    expect(await view(owner, { contact: theirs })).toEqual({ allowed: true, partial: false, refused: "not_found" });

    const c = await contact("דליה");
    for (const key of ["balances", "documents", "payments"]) {
      await setFeatures({ ...FEATURES, [key]: false });
      try {
        expect(await view(owner, { contact: c }), key).toEqual({ allowed: false });
      } finally {
        await setFeatures(FEATURES);
      }
    }
  });

  it("is security invoker, granted to signed-in people only", async () => {
    const row = await asAdmin((q) =>
      one<{ definer: boolean; anon: boolean; auth: boolean }>(
        q,
        `select p.prosecdef as definer, has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as auth
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'statement_staff_view'`,
      ),
    );
    expect(row).toEqual({ definer: false, anon: false, auth: true });
  });
});

import { createHash } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Doc = { type: string; number: string | null; doc_date: string; due_date: string | null; amount_agorot: number; balance_agorot: number; overdue_days: number };
type Answer = {
  business: Record<string, unknown>;
  brand: Record<string, unknown>;
  customer: { name: string | null };
  today: string;
  currency: string;
  documents: Doc[];
  more: number;
  payments: Array<{ paid_on: string; method: string; amount_agorot: number }>;
  payments_more: number;
  bank: Record<string, unknown> | null;
  totals: { open_agorot: number; overdue_agorot: number; credit_agorot: number };
  built_with: boolean;
  rate_limited?: boolean;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * BAL-04: the customer's statement page through a secret link. Made, seen and turned off by whoever records payments (BAL-01's
 * rule), with the ledger's keys, never while part of the customer's money is hidden from the maker. The page
 * (public.statement_public, service_role only) answers only the business, the customer's name, today and BAL-02's open debt
 * documents with their balances, the totals and the credit: no ids, nothing of another customer or business.
 */
describe("the customer's statement link (BAL-04)", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, balances: true, granular_permissions: true };

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  // calendar days from today in the business's zone (adding 24-hour steps to now() is a day off near midnight across a DST change)
  const day = (offset: number) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const setFeatures = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const company = (name: string, orgId = org, u = owner) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
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
  const doc = (type: string, amount: number, due: string | null, on: { deal?: string | null; contact?: string | null }, proforma: string | null = null, u = owner, orgId = org) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date, proforma_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id",
          [orgId, on.deal ?? null, on.contact ?? null, type, `ST-${++n}`, day(-60), amount, due, proforma],
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
  const create = (u: U, where: { contact?: string; company?: string }, orgId = org) =>
    run(u, async (q) => (await one<{ t: string }>(q, "select public.statement_link_create($1, $2, $3) as t", [orgId, where.contact ?? null, where.company ?? null])).t);
  const revoke = (u: U, where: { contact?: string; company?: string }) =>
    run(u, async (q) => (await one<{ r: boolean }>(q, "select public.statement_link_revoke($1, $2, $3) as r", [org, where.contact ?? null, where.company ?? null])).r);
  const status = (u: U, where: { contact?: string; company?: string }) =>
    run(u, async (q) =>
      (await one<{ s: { active: boolean; created_at: string | null } }>(q, "select public.statement_link_status($1, $2, $3) as s", [org, where.contact ?? null, where.company ?? null])).s,
    );
  const page = (token: string, ip: string | null = null) => asService(async (q) => (await one<{ p: Answer }>(q, "select public.statement_public($1, $2) as p", [token, ip])).p);
  const notFound = async (token: string) => expect((await pgError(page(token))).code).toBe("P0002");
  const balances = (p: Answer) => p.documents.map((d) => [d.type, Number(d.amount_agorot), Number(d.balance_agorot)]);

  beforeAll(async () => {
    owner = await createUser("st-owner");
    org = await createOrg(owner.id, "עסק דף החשבון");
    admin = await addMember(org, owner.id, "admin", "st-admin");
    manager = await addMember(org, owner.id, "manager", "st-manager");
    member = await addMember(org, owner.id, "member", "st-member");
    keyHolder = await addMember(org, owner.id, "member", "st-key");
    viewer = await addMember(org, owner.id, "viewer", "st-viewer");
    outsider = await createUser("st-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setFeatures(org, FEATURES);
    await setFeatures(otherOrg, FEATURES);
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
        `insert into public.org_document_settings (organization_id, vat_status, legal_name, tax_id, phone) values ($1, 'licensed', 'דף החשבון בע"מ', '515555555', '03-5550000')
         on conflict (organization_id) do update set legal_name = excluded.legal_name, phone = excluded.phone`,
        [org],
      ),
    );
  });

  it("whoever records payments makes, sees and turns off the link; only the hash is kept; nobody else may", async () => {
    const a = await contact("אורית");
    await doc("tax_invoice", 1000, day(5), { contact: a });
    for (const u of [member, viewer, outsider]) expect((await pgError(create(u, { contact: a }))).code, u.email).toBe("42501");
    expect((await pgError(asService((q) => q("select public.statement_link_create($1, $2, null)", [org, a])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.statement_link_create($1, $2, null)", [org, a])))).code).toBe("42501");
    // exactly one customer
    expect((await pgError(run(owner, (q) => q("select public.statement_link_create($1, null, null)", [org])))).code).toBe("22023");

    const token = await create(keyHolder, { contact: a });
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin((q) => one<{ token_hash: string }>(q, "select token_hash from app.statement_links where contact_id = $1", [a]));
    expect(stored.token_hash).toBe(sha256(token));
    const audit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where entity_id = $1 and action = 'statement_link'", [a])).rows);
    expect(audit.length).toBe(1);
    expect(JSON.stringify(audit)).not.toContain(token);
    expect(JSON.stringify(audit)).not.toContain(stored.token_hash);
    for (const u of [owner, admin, manager, keyHolder]) expect(await status(u, { contact: a }), u.email).toMatchObject({ active: true });
    for (const u of [member, viewer]) expect((await pgError(status(u, { contact: a }))).code, u.email).toBe("42501");
    for (const u of [member, outsider]) expect((await pgError(revoke(u, { contact: a }))).code, u.email).toBe("42501");

    // a new link replaces the old one
    const second = await create(manager, { contact: a });
    await notFound(token);
    expect((await page(second)).documents.length).toBe(1);
    expect(await revoke(keyHolder, { contact: a })).toBe(true);
    expect(await revoke(keyHolder, { contact: a })).toBe(false);
    await notFound(second);
    expect(await status(owner, { contact: a })).toMatchObject({ active: false, created_at: null });
    // nobody but the service role reads the page; nobody reads the link tables or calls the issuer through the API roles
    expect((await pgError(run(owner, (q) => q("select public.statement_public($1)", [second])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.statement_public($1)", [second])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select * from app.statement_links")))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("select * from app.statement_link_view_counts")))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select app.statement_link_issue($1, $2, null)", [org, a])))).code).toBe("42501");
  });

  it("a contact of a company, a customer in the bin, missing keys, a read-only business and hidden money are refused", async () => {
    const co = await company("חברת הסירוב");
    const inCo = await contact("בני", co);
    expect((await pgError(create(owner, { contact: inCo }))).hint).toBe("statement_link:company");
    const binned = await contact("גילה");
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(create(owner, { contact: binned }))).hint).toBe("statement_link:deleted");

    const c = await contact("דליה");
    for (const key of ["balances", "documents", "payments"]) {
      await setFeatures(org, { ...FEATURES, [key]: false });
      try {
        expect((await pgError(create(owner, { contact: c }))).hint, key).toBe(`feature:${key}`);
      } finally {
        await setFeatures(org, FEATURES);
      }
    }
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(create(owner, { contact: c }))).hint).toBe("org:read_only");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }

    // a key holder who cannot read a deal of the company (visibility own) cannot make the company's link
    const part = await company("חברה חלקית", org, keyHolder);
    await contact("הדר", part, keyHolder.id);
    const hidden = await deal(null, part, owner.id);
    await doc("tax_invoice", 9000, day(-15), { deal: hidden });
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect((await pgError(create(keyHolder, { company: part }))).hint).toBe("statement_link:partial");
      // nor a customer they do not read at all
      const notMine = await contact("ורד");
      expect((await pgError(create(keyHolder, { contact: notMine }))).code).toBe("42501");
      expect(await create(owner, { company: part })).toMatch(/^[A-Za-z0-9_-]{64}$/);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // another business's customer
    const theirs = await run(outsider, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [otherOrg, outsider.id])).id);
    expect((await pgError(create(owner, { contact: theirs }))).code).toBe("42501");
    expect((await pgError(create(owner, { contact: theirs }, otherOrg))).code).toBe("42501");
  });

  it("the page holds exactly the allowed keys, no ids; open documents with balances, the overdue part and the credit", async () => {
    const e = await contact("זהבה");
    await run(owner, (q) => q("update public.contacts set billing_name = 'זהבה בע\"מ' where id = $1", [e]));
    const late = await doc("tax_invoice", 10000, day(-10), { contact: e });
    await doc("tax_invoice", 5000, day(3), { contact: e });
    // paid in full: not shown
    const paid = await doc("tax_invoice", 2000, day(-30), { contact: e });
    // a proforma billed by an invoice: counted once, on the invoice
    const pro = await doc("proforma", 3000, day(-5), { contact: e });
    await doc("tax_invoice", 3000, day(-2), { contact: e }, pro);
    // never debt
    await doc("receipt", 700, null, { contact: e });
    await doc("credit_invoice", 600, null, { contact: e });
    const p1 = await pay(4000, { contact: e });
    await allocate(p1, late, 4000);
    const p2 = await pay(2000, { contact: e });
    await allocate(p2, paid, 2000);
    // an unallocated payment: credit (its note never reaches the page)
    const credit = await pay(1500, { contact: e });
    await run(owner, (q) => q("update public.payments set note = 'הערה פנימית', reference = 'REF-SECRET' where id = $1", [credit]));

    const token = await create(owner, { contact: e });
    const p = await page(token);
    expect(Object.keys(p).sort()).toEqual(["bank", "brand", "built_with", "business", "currency", "customer", "documents", "more", "payments", "payments_more", "today", "totals"]);
    for (const x of p.payments) expect(Object.keys(x).sort()).toEqual(["amount_agorot", "method", "paid_on"]);
    expect(Object.keys(p.business).sort()).toEqual(["address_line", "city", "email", "legal_name", "name", "phone", "postal_code", "tax_id"]);
    expect(Object.keys(p.brand).sort()).toEqual(["color", "logo"]);
    expect(Object.keys(p.totals).sort()).toEqual(["credit_agorot", "open_agorot", "overdue_agorot"]);
    for (const d of p.documents) expect(Object.keys(d).sort()).toEqual(["amount_agorot", "balance_agorot", "doc_date", "due_date", "number", "overdue_days", "type"]);
    expect(JSON.stringify(p)).not.toMatch(UUID);
    expect(JSON.stringify(p)).not.toContain("הערה פנימית");
    expect(JSON.stringify(p)).not.toContain("REF-SECRET");
    expect(p.business).toMatchObject({ name: "עסק דף החשבון", legal_name: 'דף החשבון בע"מ', phone: "03-5550000" });
    expect(p.customer.name).toBe('זהבה בע"מ');
    expect(p.today).toBe(day(0));
    expect(p.currency).toBe("ILS");
    // oldest due first
    expect(balances(p)).toEqual([
      ["tax_invoice", 10000, 6000],
      ["tax_invoice", 3000, 3000],
      ["tax_invoice", 5000, 5000],
    ]);
    expect(p.documents.map((d) => d.overdue_days)).toEqual([10, 2, 0]);
    expect(p.totals).toEqual({ open_agorot: 14000, overdue_agorot: 9000, credit_agorot: 1500 });
    expect(p.more).toBe(0);
    // the same open debt as the card (BAL-02)
    const card = await run(owner, async (q) => (await one<{ s: { open_debt: number; overdue_debt: number } }>(q, "select public.customer_debt_summary($1, $2, null) as s", [org, e])).s);
    expect([Number(card.open_debt), Number(card.overdue_debt)]).toEqual([14000, 9000]);

    // the design hides the business details and the logo
    await run(owner, (q) => q("insert into public.quote_designs (organization_id, show_business_details, show_logo) values ($1, false, false) on conflict (organization_id) do update set show_business_details = false, show_logo = false", [org]));
    try {
      const hiddenDetails = await page(token);
      expect(hiddenDetails.business).toMatchObject({ name: "עסק דף החשבון", legal_name: null, tax_id: null, phone: null });
      expect(hiddenDetails.brand.logo).toBeNull();
    } finally {
      await run(owner, (q) => q("update public.quote_designs set show_business_details = true, show_logo = true where organization_id = $1", [org]));
    }
  });

  it("a company's page: its opening balance, its contacts' and deals' documents, nothing of another customer or business", async () => {
    const co = await company("חברת הדף");
    const c1 = await contact("חנה", co);
    const d = await deal(null, co);
    await doc("tax_invoice", 1000, day(-20), { contact: c1 });
    await doc("proforma", 2000, day(-3), { deal: d });
    await run(owner, (q) => q("select public.opening_balance_set($1, null, $2, 4000, $3, $4)", [org, co, day(-200), day(-70)]));
    // another customer of the same business, a contact without a company, and another business's document
    const stranger = await contact("טובה");
    await doc("tax_invoice", 777, day(-1), { contact: stranger });
    const theirs = await run(outsider, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'אחר', $2) returning id", [otherOrg, outsider.id])).id);
    await doc("tax_invoice", 888, day(-1), { contact: theirs }, null, outsider, otherOrg);

    const token = await create(admin, { company: co });
    const p = await page(token);
    expect(p.customer.name).toBe("חברת הדף");
    expect(balances(p)).toEqual([
      ["opening_balance", 4000, 4000],
      ["tax_invoice", 1000, 1000],
      ["proforma", 2000, 2000],
    ]);
    expect(p.documents[0].number).toBeNull();
    expect(p.totals).toMatchObject({ open_agorot: 7000, overdue_agorot: 7000 });
    const amounts = p.documents.map((x) => Number(x.amount_agorot));
    expect(amounts).not.toContain(777);
    expect(amounts).not.toContain(888);

    // a negative opening balance of a contact without a company is credit, shown apart
    const f = await contact("יפה");
    await doc("tax_invoice", 2500, day(-1), { contact: f });
    await run(owner, (q) => q("select public.opening_balance_set($1, $2, null, -800, $3, null)", [org, f, day(-100)]));
    const fp = await page(await create(owner, { contact: f }));
    expect(fp.totals).toEqual({ open_agorot: 2500, overdue_agorot: 2500, credit_agorot: 800 });
    expect(balances(fp)).toEqual([["tax_invoice", 2500, 2500]]);
  });

  it("not found: closed public pages, a missing key, a binned customer, a contact that joined a company; back when it holds again", async () => {
    const g = await contact("כרמל");
    await doc("tax_invoice", 500, day(1), { contact: g });
    const token = await create(owner, { contact: g });
    expect((await page(token)).documents.length).toBe(1);
    await notFound("x".repeat(64));
    await notFound("short");

    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    await notFound(token);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    await setFeatures(org, { ...FEATURES, balances: false });
    await notFound(token);
    expect(await status(owner, { contact: g })).toMatchObject({ active: false });
    await setFeatures(org, FEATURES);
    expect((await page(token)).documents.length).toBe(1);

    const co = await company("חברה חדשה");
    await run(owner, (q) => q("update public.contacts set company_id = $2 where id = $1", [g, co]));
    await notFound(token);
    await run(owner, (q) => q("update public.contacts set company_id = null where id = $1", [g]));
    expect((await page(token)).documents.length).toBe(1);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [g]));
    await notFound(token);
    // a purge takes the link with it
    await asAdmin((q) => q("delete from public.contacts where id = $1", [g]));
    expect(await asAdmin(async (q) => (await q("select 1 from app.statement_links where contact_id = $1", [g])).rowCount)).toBe(0);
  });

  it("views are limited per link and per sender (keyed IP hash, scoped to the link); no hash is stored", async () => {
    const h = await contact("לאה");
    const token = await create(owner, { contact: h });
    const hash = "a".repeat(64);
    for (let i = 0; i < 60; i++) expect((await page(token, hash)).rate_limited, `view ${i + 1}`).toBeUndefined();
    expect(await page(token, hash)).toEqual({ rate_limited: true });
    // senders share 1,024 buckets per link, keyed by the link's random id: pick a sender whose bucket is not hash's
    // (a fixed second hash collided once in 1,024 runs, CI run 42559410141)
    const other = await asAdmin(async (q) => {
      const bucket = async (sender: string) =>
        (await one<{ b: number }>(q, `select ((hashtextextended(app.statement_link_sender(l.id, $2), 0) % 1024) + 1024) % 1024 as b
                                         from app.statement_links l where l.contact_id = $1`, [h, sender])).b;
      const taken = await bucket(hash);
      for (const c of "bcdef") if ((await bucket(c.repeat(64))) !== taken) return c.repeat(64);
      throw new Error("no free bucket");
    });
    expect((await page(token, other)).documents).toBeDefined();
    const stored = await asAdmin(async (q) => JSON.stringify((await q("select v.* from app.statement_link_view_counts v join app.statement_links l on l.id = v.link_id where l.contact_id = $1", [h])).rows));
    expect(stored).not.toContain(hash);
    await asAdmin((q) => q("update app.statement_links set window_started_at = now(), window_count = 120 where contact_id = $1", [h]));
    expect(await page(token, "c".repeat(64))).toEqual({ rate_limited: true });
  });

  it("the issuer called directly: refused for a customer the caller does not read; the partial rule is all it skips (review)", async () => {
    const issue = (u: U, where: { contact?: string; company?: string }) =>
      run(u, async (q) => (await one<{ t: string }>(q, "select app.statement_link_issue($1, $2, $3) as t", [org, where.contact ?? null, where.company ?? null])).t);
    const notMine = await contact("מירב");
    const notMineCo = await company("חברה זרה");
    const mineCo = await company("חברה של המחזיק", org, keyHolder);
    const hiddenDeal = await deal(null, mineCo, owner.id);
    await doc("tax_invoice", 4200, day(-4), { deal: hiddenDeal });
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect((await pgError(issue(keyHolder, { contact: notMine }))).code).toBe("42501");
      expect((await pgError(issue(keyHolder, { company: notMineCo }))).code).toBe("42501");
      // no right to record payments, even on a customer they read
      const membersOwn = await contact("נוי", null, member.id);
      expect((await pgError(issue(member, { contact: membersOwn }))).code).toBe("42501");
      // another business's customer
      const theirs = await run(outsider, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'זרה', $2) returning id", [otherOrg, outsider.id])).id);
      expect((await pgError(issue(keyHolder, { company: theirs }))).code).toBe("42501");
      expect((await pgError(run(keyHolder, (q) => q("select app.statement_link_issue($1, null, $2)", [otherOrg, theirs])))).code).toBe("42501");
      // a customer they read: today the direct call skips only the partial rule (create refuses it, the issuer does not)
      expect((await pgError(create(keyHolder, { company: mineCo }))).hint).toBe("statement_link:partial");
      const token = await issue(keyHolder, { company: mineCo });
      expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect((await page(token)).totals.open_agorot).toBe(4200);
      // and every other check still holds
      const inCo = await contact("רז", mineCo, keyHolder.id);
      expect((await pgError(issue(keyHolder, { contact: inCo }))).hint).toBe("statement_link:company");
      await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
      try {
        expect((await pgError(issue(keyHolder, { company: mineCo }))).hint).toBe("org:read_only");
      } finally {
        await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
      }
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("status and turning off need a customer the caller reads (review)", async () => {
    const theirs = await contact("שקד");
    await create(owner, { contact: theirs });
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect((await pgError(status(keyHolder, { contact: theirs }))).code).toBe("42501");
      expect((await pgError(revoke(keyHolder, { contact: theirs }))).code).toBe("42501");
      expect(await status(owner, { contact: theirs })).toMatchObject({ active: true });
      const mine = await contact("תמר", null, keyHolder.id);
      await create(keyHolder, { contact: mine });
      expect(await status(keyHolder, { contact: mine })).toMatchObject({ active: true });
      expect(await revoke(keyHolder, { contact: mine })).toBe(true);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    expect(await status(keyHolder, { contact: theirs })).toMatchObject({ active: true });
    // a customer in the bin can still be seen and turned off
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [theirs]));
    expect(await status(keyHolder, { contact: theirs })).toMatchObject({ active: false });
    expect(await revoke(keyHolder, { contact: theirs })).toBe(true);
  });

  it("a deputy who reads a customer only through HEB-08's deputy rule cannot make, see or turn off its link (fails closed)", async () => {
    const away = await addMember(org, owner.id, "member", "st-away");
    const theirs = await contact("ענבל", null, away.id);
    await doc("tax_invoice", 800, day(3), { contact: theirs });
    await create(owner, { contact: theirs });
    // the absent person's open task links the customer; the key holder is the deputy while the absence lasts
    await run(owner, (q) => q("insert into public.tasks (organization_id, title, owner_id, contact_id) values ($1, 'לחזור ללקוח', $2, $3)", [org, away.id, theirs]));
    await run(owner, (q) =>
      q(
        `insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id)
         values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date - 1, (now() at time zone 'Asia/Jerusalem')::date + 2, 'vacation', $3)`,
        [org, away.id, keyHolder.id],
      ),
    );
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // the deputy does read it (RLS), but not by app.user_can_read_record
      expect(await run(keyHolder, async (q) => (await q("select 1 from public.contacts where id = $1", [theirs])).rowCount)).toBe(1);
      expect((await pgError(create(keyHolder, { contact: theirs }))).code).toBe("42501");
      expect((await pgError(status(keyHolder, { contact: theirs }))).code).toBe("42501");
      expect((await pgError(revoke(keyHolder, { contact: theirs }))).code).toBe("42501");
      expect(await status(owner, { contact: theirs })).toMatchObject({ active: true });
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1 and user_id = $2", [org, away.id]));
    }
  });

  it("not found while the plan lacks documents or payments; back when it has them again", async () => {
    const k = await contact("עדי");
    await doc("tax_invoice", 300, day(2), { contact: k });
    const token = await create(owner, { contact: k });
    for (const key of ["documents", "payments"]) {
      await setFeatures(org, { ...FEATURES, [key]: false });
      try {
        await notFound(token);
      } finally {
        await setFeatures(org, FEATURES);
      }
      expect((await page(token)).documents.length, key).toBe(1);
    }
  });

  it("a company's totals equal its card (BAL-02), and its credit counts its contacts' payments (PAY-03)", async () => {
    const co = await company("חברת הזיכוי");
    const c1 = await contact("אביב", co);
    const c2 = await contact("ברק", co);
    const d = await deal(c2, co);
    await doc("tax_invoice", 6000, day(-8), { contact: c1 });
    const inv = await doc("tax_invoice", 3500, day(4), { deal: d });
    const partial = await pay(1000, { deal: d });
    await allocate(partial, inv, 1000);
    // unallocated payments of its contacts: the company's credit
    await pay(1200, { contact: c1 });
    await pay(300, { contact: c2 });
    const p = await page(await create(owner, { company: co }));
    const card = await run(owner, async (q) => (await one<{ s: { open_debt: number; overdue_debt: number; partial: boolean } }>(q, "select public.customer_debt_summary($1, null, $2) as s", [org, co])).s);
    expect(card.partial).toBe(false);
    expect([Number(p.totals.open_agorot), Number(p.totals.overdue_agorot)]).toEqual([Number(card.open_debt), Number(card.overdue_debt)]);
    expect(p.totals).toEqual({ open_agorot: 8500, overdue_agorot: 6000, credit_agorot: 1500 });
  });

  it("at most 500 documents, oldest due first; `more` counts the rest and the totals count all", async () => {
    const m = await contact("רבים");
    await asAdmin((q) =>
      q(
        `insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date)
         select $1, $2, 'tax_invoice', 'BULK-' || g, $3::date, 100, $3::date + g from generate_series(1, 503) g`,
        [org, m, day(-30)],
      ),
    );
    const p = await page(await create(owner, { contact: m }));
    expect(p.documents.length).toBe(500);
    expect(Number(p.more)).toBe(3);
    expect(p.documents[0].number).toBe("BULK-1");
    expect(p.documents[499].number).toBe("BULK-500");
    expect(Number(p.totals.open_agorot)).toBe(50300);
  });

  it("payments of the last 12 months: recorded/confirmed only, this customer only, date, method and amount only (answer (2) ב)", async () => {
    const co = await company("חברת התשלומים");
    const c1 = await contact("מאיה", co);
    const d = await deal(null, co);
    const other = await contact("זר לגמרי");
    const payOn = (amount: number, on: { deal?: string | null; contact?: string | null }, paidOn: string, method = "transfer", extra = "") =>
      run(owner, async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, paid_on, method${extra ? ", cheque_number, cheque_bank, cheque_branch, cheque_due_date, cheque_status" : ""})
             values ($1, $2, $3, $4, $5, $6${extra ? ", '734591', '12', '345', $5::date + 30, 'in_hand'" : ""}) returning id`,
            [org, on.deal ?? null, on.contact ?? null, amount, paidOn, method],
          )
        ).id,
      );
    const shown1 = await payOn(1111, { contact: c1 }, day(-3));
    await run(owner, (q) => q("update public.payments set note = 'הערה סודית', reference = 'REF-PAY-SECRET' where id = $1", [shown1]));
    await payOn(2222, { deal: d }, day(-300), "cheque", "cheque");
    // outside the 12 months, another customer, another business, cancelled, failed and refunded: never shown
    await payOn(3333, { contact: c1 }, day(-400));
    await payOn(4444, { contact: other }, day(-2));
    await run(outsider, async (q) => {
      const theirs = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [otherOrg, outsider.id])).id;
      await q("insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 5555, $3, 'cash')", [otherOrg, theirs, day(-2)]);
    });
    const cancelled = await payOn(6666, { contact: c1 }, day(-5));
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    const failed = await payOn(7777, { contact: c1 }, day(-6));
    await run(owner, (q) => q("update public.payments set status = 'failed' where id = $1", [failed]));
    const refunded = await payOn(8888, { contact: c1 }, day(-7));
    await run(owner, (q) => q("update public.payments set status = 'refunded' where id = $1", [refunded]));
    const confirmed = await payOn(9999, { contact: c1 }, day(-10));
    await run(owner, (q) => q("update public.payments set status = 'confirmed' where id = $1", [confirmed]));

    const p = await page(await create(owner, { company: co }));
    expect(p.payments).toEqual([
      { paid_on: day(-3), method: "transfer", amount_agorot: 1111 },
      { paid_on: day(-10), method: "transfer", amount_agorot: 9999 },
      { paid_on: day(-300), method: "cheque", amount_agorot: 2222 },
    ]);
    expect(Number(p.payments_more)).toBe(0);
    const text = JSON.stringify(p);
    // the cheque branch (3 digits) is not searched as text, too short to be unique: each row has exactly three keys
    for (const x of p.payments) expect(Object.keys(x).sort()).toEqual(["amount_agorot", "method", "paid_on"]);
    for (const secret of ["הערה סודית", "REF-PAY-SECRET", "734591"]) expect(text, secret).not.toContain(secret);
    expect(text).not.toMatch(UUID);

    // a contact without a company sees only its own payments; a payment on its deal with no contact_id is not its own
    // (the ledger's scope: a contact without a company has no "same deals")
    const solo = await contact("סולו");
    await payOn(1234, { contact: solo }, day(-1));
    const soloDeal = await deal(solo, null);
    await payOn(4321, { deal: soloDeal }, day(-1));
    expect((await page(await create(owner, { contact: solo }))).payments).toEqual([{ paid_on: day(-1), method: "transfer", amount_agorot: 1234 }]);

    // a payment on the company's deal whose contact is another customer (a contact without a company) shows on both pages,
    // as the ledger counts it for both
    const cross = await contact("לקוח אחר");
    const crossDeal = await deal(cross, co);
    await payOn(5678, { deal: crossDeal, contact: cross }, day(-2));
    expect((await page(await create(owner, { company: co }))).payments.map((x) => Number(x.amount_agorot))).toContain(5678);
    expect((await page(await create(owner, { contact: cross }))).payments).toEqual([{ paid_on: day(-2), method: "transfer", amount_agorot: 5678 }]);

    // the 12-month window in the business's zone: after today minus 12 months, up to today
    const edge = await contact("גבול");
    const bound = await asAdmin(async (q) =>
      (await one<{ b: string }>(q, "select to_char(((now() at time zone 'Asia/Jerusalem')::date - interval '12 months')::date, 'YYYY-MM-DD') as b")).b,
    );
    const after = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char($1::date + 1, 'YYYY-MM-DD') as d", [bound])).d);
    await payOn(101, { contact: edge }, day(-365));
    await payOn(102, { contact: edge }, day(-366));
    await payOn(103, { contact: edge }, bound);
    await payOn(104, { contact: edge }, after);
    await payOn(105, { contact: edge }, day(1));
    await payOn(106, { contact: edge }, day(0));
    const edgeShown = (await page(await create(owner, { contact: edge }))).payments.map((x) => [x.paid_on, Number(x.amount_agorot)]);
    expect(edgeShown).toContainEqual([day(0), 106]);
    expect(edgeShown).toContainEqual([after, 104]);
    // exactly 12 months back, a day before it, and a future date: never shown
    for (const amount of [102, 103, 105]) expect(edgeShown.map((x) => x[1]), String(amount)).not.toContain(amount);
    // day(-365) is the boundary itself in a year without 29 February in between, else the day after it
    expect(edgeShown.map((x) => x[1]).includes(101)).toBe(day(-365) > bound);
    expect(edgeShown.length).toBe(day(-365) > bound ? 3 : 2);

    // at most 500, newest first; payments_more counts the rest
    const many = await contact("הרבה תשלומים");
    await asAdmin((q) =>
      q(
        `insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method)
         select $1, $2, 100, $3::date - (g % 200), 'cash' from generate_series(1, 503) g`,
        [org, many, day(0)],
      ),
    );
    const mp = await page(await create(owner, { contact: many }));
    expect(mp.payments.length).toBe(500);
    expect(Number(mp.payments_more)).toBe(3);
    expect(mp.payments[0].paid_on).toBe(day(0));
  });

  it("bank details: read now while the statement's switch is on; never in audit_log (answer (4) ב)", async () => {
    const c = await contact("בנקאית");
    const token = await create(owner, { contact: c });
    // no account yet: nothing
    expect((await page(token)).bank).toBeNull();
    await run(owner, (q) =>
      q(
        `insert into public.org_bank_details (organization_id, bank_name, bank_branch, bank_account, bank_account_name) values ($1, 'בנק הדוגמה', '789', '99887766', 'דף החשבון בע"מ')
         on conflict (organization_id) do update set bank_name = excluded.bank_name, bank_branch = excluded.bank_branch, bank_account = excluded.bank_account, bank_account_name = excluded.bank_account_name`,
        [org],
      ),
    );
    expect((await page(token)).bank).toEqual({ bank_name: "בנק הדוגמה", bank_branch: "789", bank_account: "99887766", bank_account_name: 'דף החשבון בע"מ' });
    // the switch is the statement's own: the quote and order switches do not hide it
    await run(owner, (q) =>
      q(
        "insert into public.quote_designs (organization_id, show_bank_details_quote, show_bank_details_order) values ($1, false, false) on conflict (organization_id) do update set show_bank_details_quote = false, show_bank_details_order = false",
        [org],
      ),
    );
    try {
      expect((await page(token)).bank).not.toBeNull();
      await run(owner, (q) => q("update public.quote_designs set show_bank_details_statement = false where organization_id = $1", [org]));
      const hidden = await page(token);
      expect(hidden.bank).toBeNull();
      expect(JSON.stringify(hidden)).not.toContain("99887766");
      // nobody but the business's owners and admins sets it: a member or viewer changes nothing, a member's insert is
      // refused, and an admin of another business reaches neither this row nor a new one
      for (const u of [member, viewer, outsider]) {
        expect(await run(u, async (q) => (await q("update public.quote_designs set show_bank_details_statement = true where organization_id = $1", [org])).rowCount), u.email).toBe(0);
      }
      for (const u of [member, viewer, outsider]) {
        expect((await pgError(run(u, (q) => q("insert into public.quote_designs (organization_id, show_bank_details_statement) values ($1, true)", [org])))).code, u.email).toBe("42501");
      }
      expect((await page(token)).bank).toBeNull();
    } finally {
      await run(owner, (q) => q("update public.quote_designs set show_bank_details_statement = true, show_bank_details_quote = true, show_bank_details_order = true where organization_id = $1", [org]));
    }
    expect((await page(token)).bank).not.toBeNull();
    const audit = await asAdmin(async (q) => JSON.stringify((await q("select changes from public.audit_log where organization_id = $1", [org])).rows));
    expect(audit).not.toContain("99887766");
    const column = await asAdmin((q) =>
      one<{ d: string; nn: string; ins: boolean; upd: boolean }>(
        q,
        `select column_default as d, is_nullable as nn,
                has_column_privilege('authenticated', 'public.quote_designs', 'show_bank_details_statement', 'INSERT') as ins,
                has_column_privilege('authenticated', 'public.quote_designs', 'show_bank_details_statement', 'UPDATE') as upd
           from information_schema.columns where table_schema = 'public' and table_name = 'quote_designs' and column_name = 'show_bank_details_statement'`,
      ),
    );
    expect(column).toEqual({ d: "true", nn: "NO", ins: true, upd: true });
  });

  it("grants: the page is for the service role only; the staff functions for signed-in people", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ f: string; anon: boolean; auth: boolean; service: boolean }>(
          `select p.proname as f,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth,
                  has_function_privilege('service_role', p.oid, 'execute') as service
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'statement_%' order by 1`,
        )
      ).rows,
    );
    expect(rows).toEqual([
      { f: "statement_link_create", anon: false, auth: true, service: true },
      { f: "statement_link_revoke", anon: false, auth: true, service: true },
      { f: "statement_link_status", anon: false, auth: true, service: true },
      { f: "statement_public", anon: false, auth: false, service: true },
      { f: "statement_staff_view", anon: false, auth: true, service: true },
    ]);
  });
});

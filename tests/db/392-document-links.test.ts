import { createHash, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asService, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Answer = {
  business?: { name: string; display_name: string };
  brand?: { logo: string | null; color: string | null };
  today?: string;
  document?: {
    type: string;
    number: string;
    doc_date: string;
    due_date: string | null;
    amount_agorot: number;
    net_agorot: number | null;
    vat_agorot: number | null;
    vat_rate_bp: number | null;
    allocation_number: string | null;
    pay_state: string | null;
    balance_agorot: number | null;
    overdue_days: number;
  };
  lines?: Array<Record<string, unknown>>;
  file?: boolean;
  status_page?: { cancelled: boolean; type: string; number: string };
  built_with?: boolean;
  rate_limited?: boolean;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * DOC-15 (owner (414) א; CLAUDE.md hard rule 5's approved pattern): the customer's page of one accounting document through a
 * secret link. Made, seen and turned off by whoever records or issues documents, for a document they read. The page
 * (public.document_public, service_role only) answers only the business's display fields and the document's own type, number,
 * dates, amounts, lines and pay state: no ids, no customer, nothing of another document or business. The file route
 * (public.document_public_file) answers only the current PDF's path, SHA-256 and size.
 */
describe("the customer's document link (DOC-15)", () => {
  let owner: U, admin: U, manager: U, member: U, issuer: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  let n = 0;
  const FEATURES = { documents: true, payments: true, granular_permissions: true };

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const day = (offset: number) => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
  const setFeatures = (orgId: string, features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [orgId, JSON.stringify(features)]));
  const contact = (name: string, ownerId: string = owner.id, orgId = org, u = owner) =>
    run(u, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, ownerId])).id,
    );
  const deal = (contactId: string | null, ownerId: string = owner.id) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עבודה', $2, $3, $4, $5) returning id",
          [org, pipelineId, stageId, contactId, ownerId],
        )
      ).id,
    );
  const doc = (type: string, amount: number, on: { deal?: string | null; contact?: string | null }, due: string | null = null, u = owner, orgId = org) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, doc_date, amount_agorot, due_date) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id",
          [orgId, on.deal ?? null, on.contact ?? null, type, `DL-${++n}`, day(-20), amount, due],
        )
      ).id,
    );
  const create = (u: U, document: string, orgId = org) =>
    run(u, async (q) => (await one<{ t: string }>(q, "select public.document_link_create($1, $2) as t", [orgId, document])).t);
  const revoke = (u: U, document: string) => run(u, async (q) => (await one<{ r: boolean }>(q, "select public.document_link_revoke($1, $2) as r", [org, document])).r);
  const status = (u: U, document: string) =>
    run(u, async (q) => (await one<{ s: { exists: boolean; usable: boolean; reason: string | null; created_at: string | null } }>(q, "select public.document_link_status($1, $2) as s", [org, document])).s);
  const existing = (u: U, documents: string[]) =>
    run(u, async (q) => (await one<{ e: string[] }>(q, "select public.document_links_existing($1, $2) as e", [org, documents])).e);
  const page = (token: string, ip: string | null = null) => asService(async (q) => (await one<{ p: Answer }>(q, "select public.document_public($1, $2) as p", [token, ip])).p);
  const file = (token: string, ip: string | null = null) =>
    asService(async (q) => (await one<{ p: Record<string, unknown> }>(q, "select public.document_public_file($1, $2) as p", [token, ip])).p);
  const notFound = async (token: string) => {
    expect((await pgError(page(token))).code).toBe("P0002");
    expect((await pgError(file(token))).code).toBe("P0002");
  };

  beforeAll(async () => {
    owner = await createUser("dl-owner");
    org = await createOrg(owner.id, "עסק המסמכים");
    admin = await addMember(org, owner.id, "admin", "dl-admin");
    manager = await addMember(org, owner.id, "manager", "dl-manager");
    member = await addMember(org, owner.id, "member", "dl-member");
    issuer = await addMember(org, owner.id, "member", "dl-issuer");
    viewer = await addMember(org, owner.id, "viewer", "dl-viewer");
    outsider = await createUser("dl-outsider");
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
    // the issue key alone (DOC-17) is enough to send a document
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{issue_documents}')", [org, issuer.id]));
  });

  it("whoever records or issues documents makes, sees and turns off the link; only the hash is kept; nobody else may", async () => {
    const a = await contact("אורית");
    const d = await doc("tax_invoice", 11700, { contact: a }, day(10));
    for (const u of [member, viewer, outsider]) expect((await pgError(create(u, d))).code, u.email).toBe("42501");
    expect((await pgError(asService((q) => q("select public.document_link_create($1, $2)", [org, d])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.document_link_create($1, $2)", [org, d])))).code).toBe("42501");
    // the outsider naming its own business with this business's document learns nothing either
    expect((await pgError(create(outsider, d, otherOrg))).code).toBe("42501");

    const token = await create(issuer, d);
    expect(token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin((q) => one<{ token_hash: string }>(q, "select token_hash from app.document_links where document_id = $1", [d]));
    expect(stored.token_hash).toBe(sha256(token));
    const audit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where entity_id = $1 and action = 'document_link'", [d])).rows);
    // ids only, so a later erasure finds the document through its link entries too
    expect(audit).toEqual([{ changes: { link: "created", contact_id: a, deal_id: null, company_id: null } }]);
    for (const u of [owner, admin, manager, issuer]) expect(await status(u, d), u.email).toMatchObject({ exists: true, usable: true });
    for (const u of [member, viewer]) expect((await pgError(status(u, d))).code, u.email).toBe("42501");
    for (const u of [member, outsider]) expect((await pgError(revoke(u, d))).code, u.email).toBe("42501");

    // a new link replaces the old one
    const second = await create(manager, d);
    await notFound(token);
    expect((await page(second)).document?.number).toBeTruthy();
    expect(await revoke(issuer, d)).toBe(true);
    expect(await revoke(issuer, d)).toBe(false);
    await notFound(second);
    expect(await status(owner, d)).toMatchObject({ exists: false, usable: false, created_at: null });
    // nobody but the service role reads the page; nobody reads the link tables through the API roles
    expect((await pgError(run(owner, (q) => q("select public.document_public($1)", [second])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.document_public_file($1)", [second])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select * from app.document_links")))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("select * from app.document_link_view_counts")))).code).toBe("42501");
  });

  it("only a document the caller reads; a type, a cancelled document, a binned record, a missing key and a read-only business are refused", async () => {
    // a manager-role recorder who cannot read the deal (visibility own) cannot send its document
    const hiddenDeal = await deal(null, owner.id);
    const hidden = await doc("tax_invoice", 500, { deal: hiddenDeal });
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents}')", [org, member.id]));
    try {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      expect((await pgError(create(member, hidden))).code).toBe("42501");
      const mine = await contact("שלי", member.id);
      const minesDoc = await doc("receipt", 300, { contact: mine });
      expect(await create(member, minesDoc)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{}')", [org, member.id]));
    }

    const c = await contact("דליה");
    const opening = await asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, doc_date, amount_agorot) values ($1, $2, 'opening_balance', null, $3, 1000) returning id",
          [org, c, day(-1)],
        )
      ).id,
    );
    expect((await pgError(create(owner, opening))).hint).toBe("document_link:type");
    const cancelled = await doc("receipt", 100, { contact: c });
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [cancelled]));
    expect((await pgError(create(owner, cancelled))).hint).toBe("document_link:cancelled");
    const binned = await contact("גילה");
    const binnedDoc = await doc("receipt", 100, { contact: binned });
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [binned]));
    expect((await pgError(create(owner, binnedDoc))).hint).toBe("document_link:deleted");

    const live = await doc("receipt", 100, { contact: c });
    await setFeatures(org, { ...FEATURES, documents: false });
    try {
      expect((await pgError(create(owner, live))).hint).toBe("feature:documents");
    } finally {
      await setFeatures(org, FEATURES);
    }
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect((await pgError(create(owner, live))).hint).toBe("org:read_only");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("the page answers only the document's own fields: no ids, no customer, no notes; the pay state and balance of a debt document", async () => {
    const b = await contact("בתיה פרטית");
    await run(owner, (q) => q("update public.contacts set billing_name = 'שם החיוב הסודי' where id = $1", [b]));
    const d = await run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "select public.accounting_document_record($1, $2, $3) as id", [
          org,
          JSON.stringify({ contact_id: b, doc_type: "tax_invoice", number: `DL-${++n}`, doc_date: day(-20), amount_agorot: 11700, due_date: day(-3), net_agorot: 10000, vat_agorot: 1700, vat_rate_bp: 1700, allocation_number: "123456789" }),
          JSON.stringify([{ description: "שירות חודשי", quantity: 1, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false }]),
        ])
      ).id,
    );
    // another document of the same customer stays out of the page
    await doc("tax_invoice", 99999, { contact: b }, day(5));
    const payment = await run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, 4000, $3, 'transfer') returning id",
          [org, b, day(-1)],
        )
      ).id,
    );
    await run(owner, (q) => q("insert into public.payment_allocations (organization_id, payment_id, document_id, amount_agorot) values ($1, $2, $3, 4000)", [org, payment, d]));
    const token = await create(owner, d);
    const p = await page(token);
    expect(Object.keys(p).sort()).toEqual(["brand", "built_with", "business", "currency", "document", "file", "lines", "today"]);
    expect(p.business).toEqual({ name: "עסק המסמכים", display_name: "עסק המסמכים" });
    expect(p.document).toMatchObject({ type: "tax_invoice", amount_agorot: 11700, pay_state: "partial", balance_agorot: 7700, overdue_days: 3, due_date: day(-3) });
    expect(p.document).toMatchObject({ net_agorot: 10000, vat_agorot: 1700, vat_rate_bp: 1700, allocation_number: "123456789" });
    expect(p.lines).toEqual([{ description: "שירות חודשי", quantity: 1, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false, total_agorot: 10000 }]);
    expect(p.file).toBe(false);
    const text = JSON.stringify(p);
    expect(text).not.toMatch(UUID);
    expect(text).not.toContain("בתיה");
    expect(text).not.toContain("שם החיוב הסודי");
    expect(text).not.toContain("99999");

    // an invoice-receipt is paid on issue; a receipt has no pay state
    const ir = await doc("tax_invoice_receipt", 500, { contact: b });
    expect((await page(await create(owner, ir))).document).toMatchObject({ pay_state: "paid_on_issue", balance_agorot: 0, overdue_days: 0 });
    const r = await doc("receipt", 500, { contact: b });
    expect((await page(await create(owner, r))).document).toMatchObject({ pay_state: null, due_date: null });

  });

  it("a cancelled document answers a status page only (no amounts, lines or reason) and no file", async () => {
    const c = await contact("חנה");
    const d = await doc("receipt", 4321, { contact: c });
    const token = await create(owner, d);
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'סיבה פנימית' where id = $1", [d]));
    const p = await page(token);
    expect(p.status_page).toMatchObject({ cancelled: true, type: "receipt" });
    expect(p.document).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("4321");
    expect(JSON.stringify(p)).not.toContain("סיבה פנימית");
    expect(await file(token)).toEqual({ unavailable: true });
  });

  it("the file: only the document's current confirmed PDF, path, SHA-256 and size only", async () => {
    const c = await contact("יעל");
    const d = await doc("receipt", 900, { contact: c });
    const token = await create(owner, d);
    expect(await file(token)).toEqual({ unavailable: true });
    const pdf = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.files (organization_id, accounting_document_id, name, mime_type, size_bytes) values ($1, $2, 'קבלה של יעל.pdf', 'application/pdf', 1000) returning id", [org, d])).id,
    );
    // waiting for confirmation: not yet
    expect(await file(token)).toEqual({ unavailable: true });
    expect((await page(token)).file).toBe(false);
    await asAdmin((q) => q("update public.files set unconfirmed_since = null where id = $1", [pdf]));
    const answer = await file(token);
    expect(Object.keys(answer).sort()).toEqual(["number", "path", "sha256", "size", "type"]);
    expect(answer.path).toMatch(new RegExp(`^${org}/`));
    expect(answer.size).toBe(1000);
    expect(JSON.stringify(answer)).not.toContain("יעל");
    expect((await page(token)).file).toBe(true);
    // a newer image version is the current file: no PDF to download
    const image = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.files (organization_id, accounting_document_id, name, mime_type, size_bytes) values ($1, $2, 'scan.png', 'image/png', 50) returning id", [org, d])).id,
    );
    await asAdmin((q) => q("update public.files set unconfirmed_since = null, created_at = now() + interval '1 second' where id = $1", [image]));
    expect(await file(token)).toEqual({ unavailable: true });
  });

  it("not found: closed public pages, a missing key, a binned record, a document with no record left; back when it holds again", async () => {
    const g = await contact("כרמל");
    const d = await doc("receipt", 500, { contact: g });
    const token = await create(owner, d);
    expect((await page(token)).document).toBeDefined();
    await notFound("x".repeat(64));
    await notFound("short");

    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    await notFound(token);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    await setFeatures(org, { ...FEATURES, documents: false });
    await notFound(token);
    await setFeatures(org, FEATURES);
    expect((await page(token)).document).toBeDefined();
    expect(await status(owner, d)).toMatchObject({ exists: true, usable: true });

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [g]));
    await notFound(token);
    // the link still exists while it does not open: the screen offers to turn it off
    expect(await status(owner, d)).toMatchObject({ exists: true, usable: false });
    // a purge leaves the document with no record: not found, and the link row stays with the document
    await asAdmin((q) => q("delete from public.contacts where id = $1", [g]));
    await notFound(token);
  });

  it("another business's link is never this business's document", async () => {
    const x = await contact("זר", outsider.id, otherOrg, outsider);
    const theirs = await doc("receipt", 700, { contact: x }, null, outsider, otherOrg);
    const theirToken = await create(outsider, theirs, otherOrg);
    expect((await page(theirToken)).business).toEqual({ name: "עסק אחר", display_name: "עסק אחר" });
    // the owner of this business cannot touch the other business's document under either business id
    expect((await pgError(create(owner, theirs))).code).toBe("42501");
    expect((await pgError(create(owner, theirs, otherOrg))).code).toBe("42501");
  });

  it("views are limited per link and per sender (keyed IP hash, scoped to the link), page and file together; no hash is stored", async () => {
    const h = await contact("לאה");
    const d = await doc("receipt", 100, { contact: h });
    const token = await create(owner, d);
    const hash = "a".repeat(64);
    for (let i = 0; i < 30; i++) expect((await page(token, hash)).rate_limited, `view ${i + 1}`).toBeUndefined();
    for (let i = 0; i < 30; i++) expect((await file(token, hash)).rate_limited, `download ${i + 1}`).toBeUndefined();
    expect(await page(token, hash)).toEqual({ rate_limited: true });
    expect(await file(token, hash)).toEqual({ rate_limited: true });
    const other = await asAdmin(async (q) => {
      const bucket = async (sender: string) =>
        (await one<{ b: number }>(q, `select ((hashtextextended(app.document_link_sender(l.id, $2), 0) % 1024) + 1024) % 1024 as b
                                         from app.document_links l where l.document_id = $1`, [d, sender])).b;
      const taken = await bucket(hash);
      for (const c of "bcdef") if ((await bucket(c.repeat(64))) !== taken) return c.repeat(64);
      throw new Error("no free bucket");
    });
    expect((await page(token, other)).document).toBeDefined();
    const stored = await asAdmin(async (q) => JSON.stringify((await q("select v.* from app.document_link_view_counts v join app.document_links l on l.id = v.link_id where l.document_id = $1", [d])).rows));
    expect(stored).not.toContain(hash);
    await asAdmin((q) => q("update app.document_links set window_started_at = now(), window_count = 120 where document_id = $1", [d]));
    expect(await page(token, "c".repeat(64))).toEqual({ rate_limited: true });
    expect(await file(token)).toEqual({ rate_limited: true });
  });

  it("a link that does not open now (binned record, key off, closed pages) can still be turned off, and never comes back", async () => {
    // a binned record
    const a = await contact("אסנת");
    const d1 = await doc("receipt", 100, { contact: a });
    const t1 = await create(issuer, d1);
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [a]));
    expect(await status(issuer, d1)).toMatchObject({ exists: true, usable: false, reason: "record_gone" });
    expect(await existing(issuer, [d1])).toEqual([d1]);
    expect(await revoke(issuer, d1)).toBe(true);
    expect(await existing(issuer, [d1])).toEqual([]);
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [a]));
    expect(await status(issuer, d1)).toMatchObject({ exists: false, usable: false });
    await notFound(t1);

    // the documents key off
    const b = await contact("בלה");
    const d2 = await doc("receipt", 100, { contact: b });
    const t2 = await create(owner, d2);
    await setFeatures(org, { ...FEATURES, documents: false });
    try {
      expect(await status(owner, d2)).toMatchObject({ exists: true, usable: false, reason: "feature_off" });
      // the card lists it without the key, to whoever has the link's rights only
      expect(await existing(owner, [d2])).toEqual([d2]);
      expect(await existing(member, [d2])).toEqual([]);
      expect(await revoke(owner, d2)).toBe(true);
    } finally {
      await setFeatures(org, FEATURES);
    }
    await notFound(t2);

    // closed public pages (a cancelled business; the owner keeps the role)
    const d3 = await doc("receipt", 100, { contact: b });
    const t3 = await create(owner, d3);
    await asAdmin((q) => q("update public.organizations set status = 'cancelled' where id = $1", [org]));
    try {
      expect(await status(owner, d3)).toMatchObject({ exists: true, usable: false, reason: "pages_closed" });
      expect(await existing(owner, [d3])).toEqual([d3]);
      expect(await revoke(owner, d3)).toBe(true);
      // the rights are still checked
      expect((await pgError(revoke(member, d3))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    await notFound(t3);
  });

  it("refused for a HEB-08 deputy who reads only through the deputy rule, a support session and a session without the second step", async () => {
    const away = await addMember(org, owner.id, "member", "dl-away");
    const deputy = await addMember(org, owner.id, "member", "dl-deputy");
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents}')", [org, deputy.id]));
    const theirs = await contact("ענבל", away.id);
    const d = await doc("receipt", 800, { contact: theirs });
    await create(owner, d);
    await run(owner, (q) => q("insert into public.tasks (organization_id, title, owner_id, contact_id) values ($1, 'לחזור ללקוח', $2, $3)", [org, away.id, theirs]));
    await run(owner, (q) =>
      q(
        `insert into public.member_leaves (organization_id, user_id, starts_on, ends_on, kind, deputy_id)
         values ($1, $2, (now() at time zone 'Asia/Jerusalem')::date - 1, (now() at time zone 'Asia/Jerusalem')::date + 2, 'vacation', $3)`,
        [org, away.id, deputy.id],
      ),
    );
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // the deputy reads the customer (RLS) and holds the documents key, but not by app.user_can_read_record
      expect(await run(deputy, async (q) => (await q("select 1 from public.contacts where id = $1", [theirs])).rowCount)).toBe(1);
      expect((await pgError(create(deputy, d))).code).toBe("42501");
      expect((await pgError(status(deputy, d))).code).toBe("42501");
      expect((await pgError(revoke(deputy, d))).code).toBe("42501");
      expect(await status(owner, d)).toMatchObject({ exists: true, usable: true });
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      await asAdmin((q) =>
        q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01', deputy_id = null where organization_id = $1 and user_id = $2", [org, away.id]),
      );
      await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{}')", [org, deputy.id]));
    }

    // platform support in a customer-approved session is a viewer
    const support = await createUser("dl-support");
    await asAdmin((q) =>
      q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]),
    );
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]));
    try {
      await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org]));
      const asSupport = <T,>(fn: (q: Query) => Promise<T>) => asMfaUser(support.id, fn);
      expect((await pgError(asSupport((q) => q("select public.document_link_create($1, $2)", [org, d])))).code).toBe("42501");
      expect((await pgError(asSupport((q) => q("select public.document_link_status($1, $2)", [org, d])))).code).toBe("42501");
      expect((await pgError(asSupport((q) => q("select public.document_link_revoke($1, $2)", [org, d])))).code).toBe("42501");
    } finally {
      await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [org]));
      await asAdmin((q) => q("delete from app.platform_staff where user_id = $1", [support.id]));
    }

    // a business that requires two-step verification: an aal1 session gets no role; aal2 does
    await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
    try {
      for (const u of [owner, issuer]) {
        expect((await pgError(create(u, d))).code, u.email).toBe("42501");
        expect((await pgError(status(u, d))).code, u.email).toBe("42501");
        expect((await pgError(revoke(u, d))).code, u.email).toBe("42501");
      }
      const viaAal2 = await asMfaUser(owner.id, async (q) =>
        (await one<{ s: { exists: boolean } }>(q, "select public.document_link_status($1, $2) as s", [org, d])).s,
      );
      expect(viaAal2).toMatchObject({ exists: true });
    } finally {
      await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
    }
  });

  it("a privacy erasure turns off the links of the person's documents, RVW-45's contact-less documents on their deal too", async () => {
    const p = await contact("פנינה למחיקה");
    const own = await doc("receipt", 100, { contact: p });
    const dl = await deal(p);
    const onDeal = await doc("receipt", 200, { deal: dl });
    const keep = await contact("אחרת");
    const other = await doc("receipt", 300, { contact: keep });
    const tokens = [await create(owner, own), await create(owner, onDeal), await create(owner, other)];
    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [p]);
      await q("delete from public.contacts where id = $1", [p]);
    });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, p]));
    const rows = await asAdmin(
      async (q) =>
        (await q<{ document_id: string; token_hash: string | null }>("select document_id, token_hash from app.document_links where document_id = any($1)", [[own, onDeal, other]]))
          .rows,
    );
    const byDoc = Object.fromEntries(rows.map((r) => [r.document_id, r.token_hash]));
    expect(byDoc[own]).toBeNull();
    expect(byDoc[onDeal]).toBeNull();
    expect(byDoc[other]).toBe(sha256(tokens[2]));
    expect((await pgError(page(tokens[1]))).code).toBe("P0002");
    // the link's own audit entries went with the document's other entries
    const entries = await asAdmin(
      async (q) => (await q<{ c: string }>("select changes::text as c from public.audit_log where entity_id = $1 and action = 'document_link'", [own])).rows,
    );
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.c === '{"erased": true}')).toBe(true);

    // a document erased through its deal keeps its contact; a new link made after that is found through its own entry when
    // the contact is erased later
    const q2 = await contact("קרן למחיקה");
    const dl2 = await deal(q2);
    const both = await doc("receipt", 400, { deal: dl2, contact: q2 });
    await create(owner, both);
    await run(owner, async (q) => {
      await q("update public.deals set deleted_at = now() where id = $1", [dl2]);
      await q("delete from public.deals where id = $1", [dl2]);
    });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, dl2]));
    expect(await asAdmin(async (q) => (await one<{ h: string | null }>(q, "select token_hash as h from app.document_links where document_id = $1", [both])).h)).toBeNull();
    const fresh = await create(owner, both);
    expect((await page(fresh)).document).toBeDefined();
    await run(owner, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [q2]);
      await q("delete from public.contacts where id = $1", [q2]);
    });
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, q2]));
    expect(await asAdmin(async (q) => (await one<{ h: string | null }>(q, "select token_hash as h from app.document_links where document_id = $1", [both])).h)).toBeNull();
    await notFound(fresh);
  });

  it("the page names the business as documents do: the registered name when set, the display name beside it", async () => {
    const x = await contact("רשום", outsider.id, otherOrg, outsider);
    const d = await doc("receipt", 700, { contact: x }, null, outsider, otherOrg);
    const token = await create(outsider, d, otherOrg);
    await run(outsider, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status, legal_name) values ($1, 'licensed', 'עסק אחר בע\"מ')", [otherOrg]),
    );
    expect((await page(token)).business).toEqual({ name: 'עסק אחר בע"מ', display_name: "עסק אחר" });
    await run(outsider, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'טעות' where id = $1", [d]));
    expect((await page(token)).business).toEqual({ name: 'עסק אחר בע"מ', display_name: "עסק אחר" });
  });

  it("the card's list of existing links: only this business's documents the caller reads, only to link managers; at most 200", async () => {
    const listAs = (u: U, orgId: string, documents: string[]) =>
      run(u, async (q) => (await one<{ e: string[] }>(q, "select public.document_links_existing($1, $2) as e", [orgId, documents])).e);
    const c = await contact("לימור");
    const d = await doc("receipt", 100, { contact: c });
    await create(owner, d);
    expect(await listAs(owner, org, [d])).toEqual([d]);

    // an outsider naming this business learns nothing
    expect(await listAs(outsider, org, [d])).toEqual([]);
    // another business's document in the array is left out
    const x = await contact("זרה", outsider.id, otherOrg, outsider);
    const theirs = await doc("receipt", 100, { contact: x }, null, outsider, otherOrg);
    await create(outsider, theirs, otherOrg);
    expect(await listAs(owner, org, [d, theirs])).toEqual([d]);
    // a viewer has no link rights
    expect(await listAs(viewer, org, [d])).toEqual([]);

    // platform support in a customer-approved session is a viewer
    const support = await createUser("dl-support-list");
    await asAdmin((q) =>
      q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]),
    );
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]));
    try {
      await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org]));
      const answer = await asMfaUser(support.id, async (q) =>
        (await one<{ e: string[] }>(q, "select public.document_links_existing($1, $2) as e", [org, [d]])).e,
      );
      expect(answer).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [org]));
      await asAdmin((q) => q("delete from app.platform_staff where user_id = $1", [support.id]));
    }

    // an issuer who does not read the document's record (visibility own, someone else's contact)
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await listAs(issuer, org, [d])).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    expect(await listAs(issuer, org, [d])).toEqual([d]);

    // more than 200 ids
    const many = Array.from({ length: 201 }, () => randomUUID());
    const tooMany = await pgError(listAs(owner, org, many));
    expect(tooMany.code).toBe("22023");
    expect(tooMany.hint).toBe("document_link:too_many");

    // a revoked link is left out; its audit entry holds the link and the document's ids only
    expect(await revoke(owner, d)).toBe(true);
    expect(await listAs(owner, org, [d])).toEqual([]);
    const revoked = await asAdmin(
      async (q) =>
        (await q<{ changes: unknown }>("select changes from public.audit_log where entity_id = $1 and action = 'document_link' and changes ->> 'link' = 'revoked'", [d]))
          .rows,
    );
    expect(revoked).toEqual([{ changes: { link: "revoked", contact_id: c, deal_id: null, company_id: null } }]);
  });

  it("the delivery setting: system by default; owners and admins choose provider; nothing else is accepted", async () => {
    const read = () => asAdmin(async (q) => (await q<{ d: string }>("select document_delivery as d from public.org_document_settings where organization_id = $1", [org])).rows[0]?.d);
    expect(await read()).toBeUndefined();
    await run(owner, (q) => q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed')", [org]));
    expect(await read()).toBe("system");
    await run(admin, (q) => q("update public.org_document_settings set document_delivery = 'provider' where organization_id = $1", [org]));
    expect(await read()).toBe("provider");
    expect((await pgError(run(owner, (q) => q("update public.org_document_settings set document_delivery = 'fax' where organization_id = $1", [org])))).code).toBe("23514");
    const changed = await run(member, async (q) => (await q("update public.org_document_settings set document_delivery = 'system' where organization_id = $1", [org])).rowCount);
    expect(changed).toBe(0);
    expect(await read()).toBe("provider");
  });
});

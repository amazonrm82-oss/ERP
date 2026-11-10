import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { markdownLiteral } from "@/features/document-templates/fields";

import { addMember, asAdmin, asAnon, asMfaUser, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Page = Record<string, unknown> & {
  document?: Record<string, unknown>;
  business?: Record<string, unknown>;
  brand?: Record<string, unknown>;
  fingerprint?: string | null;
  status_page?: Record<string, unknown>;
  rate_limited?: boolean;
};

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const WORDING = "sign-draft-2026-11-10";
// the test templates: a contact's with a locked section, a deal's with its name
const CONTACT_BODY = "**הסכם שירות**\n\nההסכם נערך בין {שם העסק} לבין {שם פרטי}.\n::: נעול\nסעיף קבוע: {שם העסק} אחראי לשירות.\n:::\nתודה.";
const DEAL_BODY = "חוזה עבור {שם העסקה}.";

/**
 * SGN-02 (owner, 9 November 2026, answer (191) א): a document filled from an SGN-01 template is sent from a record through a
 * secret link (only its SHA-256 is kept), the customer signs it on the page, and the server keeps the signed PDF. The public
 * functions are service_role only and answer only what the page needs, by one rule; views are limited per link and per
 * sender, signing tries per link; the monthly cap max_signatures_per_month is counted when a document is sent.
 */
describe("documents for signature (SGN-02)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let template: string, dealTemplate: string;

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const setPlan = (orgId: string, features: Record<string, boolean>, limits: Record<string, number | null> = {}) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = $2, limit_overrides = $3 where organization_id = $1", [orgId, JSON.stringify(features), JSON.stringify(limits)]),
    );
  const newContact = (u: U, orgId: string, name: string) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
  type Draft = { title: string; segments: { locked: boolean; text: string }[]; unfilled: string[] };
  // (224) ב: the server's own fill, as the sender's editor gets it
  const draft = (u: U, orgId: string, tpl: string, type: string, record: string) =>
    run(u, async (q) => (await one<{ d: Draft }>(q, "select public.signature_document_draft($1, $2, $3, $4) as d", [orgId, tpl, type, record])).d);
  const joined = (d: Draft) => d.segments.map((seg) => seg.text).join("\n");
  // the body sent: as given, else the server's fill (plus `extra` free text after it)
  const send = (u: U, orgId: string, record: string, opts: { template?: string; type?: string; body?: string; extra?: string; title?: string; days?: number | null } = {}) =>
    run(u, async (q) => {
      const tpl = opts.template ?? template;
      const type = opts.type ?? "contact";
      let body = opts.body;
      if (body === undefined) {
        const d = (await one<{ d: Draft }>(q, "select public.signature_document_draft($1, $2, $3, $4) as d", [orgId, tpl, type, record])).d;
        body = joined(d) + (opts.extra ? `\n${opts.extra}` : "");
      }
      return (
        await one<{ r: { id: string; token: string } }>(q, "select public.signature_document_send($1, $2, $3, $4, $5, $6, $7) as r", [
          orgId,
          tpl,
          type,
          record,
          opts.title ?? "",
          body,
          opts.days ?? null,
        ])
      ).r;
    });
  // a seeded template's text made one the test records fill (the seeds ask for fields such as a phone)
  const simplify = (u: U, orgId: string, key: string, body: string) =>
    run(u, (q) => q("update public.document_templates set body = $3 where organization_id = $1 and key = $2", [orgId, key, body]));
  const page = (token: string, ip: string | null = null) => asService(async (q) => (await one<{ p: Page }>(q, "select public.signature_public($1, $2) as p", [token, ip])).p);
  const notFound = async (token: string) => expect((await pgError(page(token))).code).toBe("P0002");
  const sign = (token: string, args: Record<string, unknown> = {}) =>
    asService(async (q) =>
      (
        await one<{ r: { status: string } }>(
          q,
          `select public.signature_public_sign(p_token => $1, p_fingerprint => $2, p_signer_name => $3, p_id_number => $4,
                   p_signature_kind => $5, p_signature_image => $6, p_wording_version => $7, p_agreed => $8, p_ip => $9,
                   p_user_agent => $10) as r`,
          [
            token,
            args.fingerprint ?? null,
            args.name ?? "דנה כהן",
            args.id ?? null,
            args.kind ?? "typed",
            args.image ?? null,
            args.wording ?? WORDING,
            args.agreed ?? true,
            args.ip ?? "203.0.113.5",
            args.ua ?? "Mozilla/5.0 test",
          ],
        )
      ).r,
    );

  beforeAll(async () => {
    owner = await createUser("sg-owner");
    org = await createOrg(owner.id, "עסק החתימות");
    admin = await addMember(org, owner.id, "admin", "sg-admin");
    member = await addMember(org, owner.id, "member", "sg-member");
    other = await addMember(org, owner.id, "member", "sg-other");
    viewer = await addMember(org, owner.id, "viewer", "sg-viewer");
    outsider = await createUser("sg-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await setPlan(org, { signatures: true });
    await setPlan(otherOrg, { signatures: true });
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    await simplify(owner, org, "service_agreement", CONTACT_BODY);
    await simplify(owner, org, "contract", DEAL_BODY);
    await simplify(outsider, otherOrg, "service_agreement", CONTACT_BODY);
    template = await run(owner, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [org])).id);
    dealTemplate = await run(owner, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'contract'", [org])).id);
  });

  it("only whoever may edit the live record sends; only the token's hash is kept; the audit holds ids only", async () => {
    const contact = await newContact(member, org, "דנה");
    for (const u of [other, viewer, outsider]) expect((await pgError(send(u, org, contact))).code, u.email).toBe("42501");
    expect((await pgError(asService((q) => q("select public.signature_document_send($1, $2, 'contact', $3, '', 'x')", [org, template, contact])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.signature_document_send($1, $2, 'contact', $3, '', 'x')", [org, template, contact])))).code).toBe("42501");

    const sent = await send(member, org, contact);
    expect(sent.token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    const stored = await asAdmin((q) => one<{ token_hash: string }>(q, "select token_hash from app.signature_links where document_id = $1", [sent.id]));
    expect(stored.token_hash).toBe(sha256(sent.token));
    const audit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where entity_id = $1", [sent.id])).rows);
    expect(audit.length).toBeGreaterThan(0);
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(sent.token);
    expect(auditText).not.toContain("דנה כהן");
    // the title falls back to the template's name; the record's readers see the document, others do not
    const doc = await run(member, (q) => one<{ title: string; status: string }>(q, "select title, status from public.signature_documents where id = $1", [sent.id]));
    expect(doc).toEqual({ title: "הסכם שירות", status: "sent" });
    expect(await run(other, (q) => count(q, "select 1 from public.signature_documents where id = $1", [sent.id]))).toBe(0);
    expect(await run(outsider, (q) => count(q, "select 1 from public.signature_documents where id = $1", [sent.id]))).toBe(0);
    // a timeline entry on the record, which no person may change
    const entry = await run(member, (q) => one<{ id: string; body: string }>(q, "select id, body from public.activities where contact_id = $1 and metadata ->> 'kind' = 'signature_sent'", [contact]));
    expect(entry.body).toContain("הסכם שירות");
    expect((await pgError(run(owner, (q) => q("delete from public.activities where id = $1", [entry.id])))).hint).toBe("activity:signature_entry");
    expect((await pgError(run(owner, (q) => q("update public.activities set body = 'x' where id = $1", [entry.id])))).hint).toBe("activity:signature_entry");
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where id = $1 and body = $2", [entry.id, entry.body]))).toBe(1);
    expect(
      (await pgError(run(member, (q) => q("insert into public.activities (organization_id, type, contact_id, body, metadata) values ($1, 'note', $2, 'x', '{\"kind\": \"signature_signed\"}')", [org, contact])))).hint,
    ).toBe("activity:signature_entry");
    // no client writes to the tables
    for (const sql of [
      "update public.signature_documents set status = 'signed', signed_at = now() where id = $1",
      "delete from public.signature_documents where id = $1",
    ]) {
      expect((await pgError(run(owner, (q) => q(sql, [sent.id])))).code).toBe("42501");
    }
  });

  it("refuses an inactive or another type's template, an unfilled field, a bad title and a missing key", async () => {
    const contact = await newContact(member, org, "רון");
    expect((await pgError(send(member, org, contact, { template: dealTemplate }))).hint).toBe("signature_document:template");
    expect((await pgError(send(member, org, contact, { body: "שלום {שם מלא}" }))).hint).toBe("signature_document:unfilled");
    // a {text} that is not a field of the type is the business's own text
    expect((await send(member, org, contact, { extra: "שלום {משהו אחר}" })).id).toMatch(UUID);
    expect((await pgError(send(member, org, contact, { title: "x".repeat(121) }))).hint).toBe("signature_document:title");
    expect((await pgError(send(member, org, contact, { days: 0 }))).hint).toBe("signature_document:valid_days");
    // another business's template
    const foreign = await run(outsider, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [otherOrg])).id);
    expect((await pgError(send(member, org, contact, { template: foreign }))).hint).toBe("signature_document:template");
    // another business's record
    const foreignContact = await newContact(outsider, otherOrg, "זר");
    expect((await pgError(send(member, org, foreignContact))).code).toBe("42501");
    await setPlan(org, { signatures: false });
    expect((await pgError(send(member, org, contact))).hint).toBe("feature:signatures");
    await setPlan(org, { signatures: true });
  });

  it("counts documents sent in the month against max_signatures_per_month", async () => {
    const limited = await createUser("sg-limit");
    const orgL = await createOrg(limited.id, "עסק מוגבל");
    await setPlan(orgL, { signatures: true }, { max_signatures_per_month: 2 });
    await simplify(limited, orgL, "service_agreement", CONTACT_BODY);
    const tpl = await run(limited, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [orgL])).id);
    const contact = await newContact(limited, orgL, "לקוח");
    await send(limited, orgL, contact, { template: tpl });
    await send(limited, orgL, contact, { template: tpl });
    expect((await pgError(send(limited, orgL, contact, { template: tpl }))).hint).toBe("limit:max_signatures_per_month");
    await setPlan(orgL, { signatures: true }, { max_signatures_per_month: null });
    expect((await send(limited, orgL, contact, { template: tpl })).id).toMatch(UUID);
  });

  it("the page answers only what it shows, marks the first view, and finds nothing past the one rule", async () => {
    const contact = await newContact(member, org, "מיכל");
    const sent = await send(member, org, contact, { extra: "טקסט המסמך" });
    const shown = await page(sent.token);
    expect(Object.keys(shown).sort()).toEqual(["brand", "built_with", "business", "document", "fingerprint", "time_zone"]);
    expect(shown.time_zone).toBe("Asia/Jerusalem");
    expect(Object.keys(shown.document ?? {}).sort()).toEqual(["body", "expires_at", "sent_at", "signed_at", "status", "title"]);
    expect(Object.keys(shown.business ?? {}).sort()).toEqual(["name", "phone"]);
    expect(Object.keys(shown.brand ?? {}).sort()).toEqual(["color", "logo"]);
    expect(JSON.stringify(shown)).not.toMatch(UUID);
    expect(String(shown.document?.body)).toMatch(/\nטקסט המסמך$/);
    expect(shown.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await run(member, (q) => one<{ status: string }>(q, "select status from public.signature_documents where id = $1", [sent.id]))).toEqual({ status: "viewed" });

    // only the service role reads the page
    for (const fn of [run.bind(null, owner), asAnon]) {
      expect((await pgError((fn as (f: (q: Query) => Promise<unknown>) => Promise<unknown>)((q) => q("select public.signature_public($1)", [sent.token])))).code).toBe("42501");
    }
    await notFound("x".repeat(64));
    await notFound("short");
    // a new link replaces the old one
    const second = await run(member, async (q) => (await one<{ t: string }>(q, "select public.signature_document_link($1, $2) as t", [org, sent.id])).t);
    await notFound(sent.token);
    expect((await page(second)).document?.title).toBe("הסכם שירות");
    expect((await pgError(run(other, (q) => q("select public.signature_document_link($1, $2)", [org, sent.id])))).code).toBe("42501");
    // the record in the bin, the key gone, public pages closed: not found
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await notFound(second);
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [contact]));
    expect((await page(second)).document).toBeDefined();
    await setPlan(org, { signatures: false });
    await notFound(second);
    await setPlan(org, { signatures: true });
    // cancelled: its state only, no text
    expect(await run(member, async (q) => (await one<{ r: boolean }>(q, "select public.signature_document_cancel($1, $2) as r", [org, sent.id])).r)).toBe(true);
    const cancelled = await page(second);
    expect(cancelled.status_page).toMatchObject({ state: "cancelled", title: "הסכם שירות" });
    expect(JSON.stringify(cancelled)).not.toContain("טקסט המסמך");
    expect((await sign(second, { fingerprint: shown.fingerprint })).status).toBe("closed");
    expect((await pgError(run(member, (q) => q("select public.signature_document_cancel($1, $2)", [org, sent.id])))).hint).toBe("signature_document:closed");
  });

  it("an expired document shows its state; views are limited per sender and per link", async () => {
    const contact = await newContact(member, org, "יעל");
    const sent = await send(member, org, contact, { days: 3 });
    await asAdmin((q) => q("update public.signature_documents set expires_at = now() - interval '1 minute' where id = $1", [sent.id]));
    expect((await page(sent.token)).status_page).toMatchObject({ state: "expired" });

    const fresh = await send(member, org, contact);
    for (let i = 0; i < 60; i++) expect((await page(fresh.token, "a".repeat(64))).rate_limited).toBeUndefined();
    expect((await page(fresh.token, "a".repeat(64))).rate_limited).toBe(true);
    // another sender still reads it, until the link's 120
    for (let i = 0; i < 59; i++) expect((await page(fresh.token, "b".repeat(64))).rate_limited).toBeUndefined();
    expect((await page(fresh.token, null)).rate_limited).toBe(true);
    // no IP hash is stored, only bucket numbers
    const buckets = await asAdmin(async (q) => (await q<Record<string, unknown>>("select * from app.signature_link_view_counts where document_id = $1", [fresh.id])).rows);
    expect(JSON.stringify(buckets)).not.toContain("aaaa");
  });

  it("signs once, on the fingerprint shown, keeps the evidence for owners and admins, and tells the sender", async () => {
    const contact = await newContact(member, org, "אורי");
    const sent = await send(member, org, contact);
    const fingerprint = (await page(sent.token)).fingerprint;
    expect((await sign(sent.token, { fingerprint: "0".repeat(64) })).status).toBe("changed");
    expect((await sign(sent.token, { fingerprint, agreed: false })).status).toBe("invalid");
    expect((await sign(sent.token, { fingerprint, wording: "" })).status).toBe("invalid");
    expect((await sign(sent.token, { fingerprint, kind: "drawn", image: null })).status).toBe("invalid");
    expect((await sign(sent.token, { fingerprint, id: "123456789" })).status).toBe("invalid");
    expect((await sign(sent.token, { fingerprint, id: "000000018" })).status).toBe("signed");
    expect((await sign(sent.token, { fingerprint })).status).toBe("already_signed");

    const signed = await page(sent.token);
    expect(signed.document?.status).toBe("signed");
    expect(signed.fingerprint).toBeNull();
    // the signature: owners and admins only
    for (const u of [owner, admin]) expect(await run(u, (q) => count(q, "select 1 from public.signature_signatures where document_id = $1", [sent.id])), u.email).toBe(1);
    for (const u of [member, viewer, outsider]) expect(await run(u, (q) => count(q, "select 1 from public.signature_signatures where document_id = $1", [sent.id])), u.email).toBe(0);
    const evidence = await asAdmin((q) => one<Record<string, unknown>>(q, "select signer_name, signer_id_number, wording_version, ip, user_agent, content_sha256 from public.signature_signatures where document_id = $1", [sent.id]));
    expect(evidence).toEqual({ signer_name: "דנה כהן", signer_id_number: "000000018", wording_version: WORDING, ip: "203.0.113.5", user_agent: "Mozilla/5.0 test", content_sha256: fingerprint });
    // the sender (also the record's owner) gets one notice with the title only
    const notices = await run(member, async (q) => (await q<{ title: string; body: string }>("select title, body from public.notifications where entity_id = $1 and title = 'מסמך נחתם בקישור'", [contact])).rows);
    expect(notices).toEqual([{ title: "מסמך נחתם בקישור", body: "הסכם שירות" }]);
    expect(await run(member, (q) => count(q, "select 1 from public.activities where contact_id = $1 and metadata ->> 'kind' = 'signature_signed' and created_by is null", [contact]))).toBe(1);
    // ten tries per link in ten minutes
    const another = await send(member, org, contact);
    for (let i = 0; i < 10; i++) expect((await sign(another.token, { fingerprint: "1".repeat(64) })).status).toBe("changed");
    expect((await sign(another.token, { fingerprint: "1".repeat(64) })).status).toBe("rate_limited");
  });

  it("keeps the signed PDF once, as a server row read by owners and admins only", async () => {
    const contact = await newContact(member, org, "נועה");
    const sent = await send(member, org, contact);
    const pdfSource = (token: string) => asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.signature_pdf_public($1) as r", [token])).r);
    expect(await pdfSource(sent.token)).toEqual({ unavailable: true });
    const fingerprint = (await page(sent.token)).fingerprint as string;
    expect((await sign(sent.token, { fingerprint })).status).toBe("signed");
    const source = await pdfSource(sent.token);
    expect(Object.keys(source).sort()).toEqual(["brand", "business", "document", "signature"]);
    expect(source.signature).toMatchObject({ signer_name: "דנה כהן", kind: "typed", fingerprint, wording_version: WORDING });
    expect(JSON.stringify(source)).not.toContain("203.0.113.5");

    const store = (path: string | null, size = 1234, fp = fingerprint) =>
      asService(async (q) =>
        (await one<{ r: { status: string; path?: string; file_id?: string } }>(q, "select public.signature_pdf_public_store($1, $2, $3, $4, $5) as r", [sent.token, size, "a".repeat(64), path, fp])).r,
      );
    expect((await store(null, 1234, "2".repeat(64))).status).toBe("changed");
    const first = await store(null);
    expect(first.status).toBe("upload");
    expect(first.path).toMatch(new RegExp(`^${org}/`));
    // the object is not there yet
    expect((await store(first.path ?? null)).status).toBe("upload");
    await asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [first.path]);
      await q("update storage.objects set metadata = jsonb_build_object('size', 1234::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [first.path]);
    });
    // a path it did not hand out is refused
    expect((await pgError(store(`${org}/00000000-0000-4000-8000-000000000000`))).hint).toBe("signature_pdf:invalid");
    const done = await store(first.path ?? null);
    expect(done.status).toBe("stored");
    expect(await pdfSource(sent.token)).toEqual({ done: true });
    expect((await store(null)).status).toBe("stored");
    const file = await asAdmin((q) => one<Record<string, unknown>>(q, "select storage_path, name, unconfirmed_since, uploaded_by, sha256 from public.files where id = $1", [done.file_id]));
    expect(file).toMatchObject({ storage_path: first.path, unconfirmed_since: null, uploaded_by: null, sha256: "a".repeat(64) });
    expect(String(file.name)).toMatch(/^מסמך חתום \d{4}-\d{2}-\d{2}\.pdf$/);
    for (const u of [owner, admin]) expect(await run(u, (q) => count(q, "select 1 from public.files where id = $1", [done.file_id])), u.email).toBe(1);
    for (const u of [member, viewer, outsider]) expect(await run(u, (q) => count(q, "select 1 from public.files where id = $1", [done.file_id])), u.email).toBe(0);
    // no person removes it, nor its object
    expect(await run(owner, async (q) => (await q("delete from public.files where id = $1", [done.file_id])).rowCount)).toBe(0);
    expect(await run(owner, async (q) => (await q("delete from storage.objects where bucket_id = 'record-files' and name = $1", [first.path])).rowCount)).toBe(0);
    // no person adds one
    expect(
      (await pgError(run(owner, (q) => q("insert into public.files (organization_id, signature_document_id, name, mime_type, size_bytes, uploaded_by) values ($1, $2, 'x.pdf', 'application/pdf', 10, $3)", [org, sent.id, owner.id])))).code,
    ).toBe("42501");

    // staff: owners and admins ask with their session; the store checks the named user again
    expect((await pgError(run(member, (q) => q("select public.signature_pdf_allowed($1, $2)", [org, sent.id])))).code).toBe("42501");
    expect(await run(owner, async (q) => (await one<{ r: unknown }>(q, "select public.signature_pdf_allowed($1, $2) as r", [org, sent.id])).r)).toBeNull();
    expect((await pgError(asService((q) => q("select public.signature_pdf_store($1, $2, $3, 10, $4)", [org, sent.id, member.id, "b".repeat(64)])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select public.signature_pdf_store($1, $2, $3, 10, $4)", [otherOrg, sent.id, outsider.id, "b".repeat(64)])))).code).toBe("42501");
    expect(
      await asService(async (q) => (await one<{ r: { status: string } }>(q, "select public.signature_pdf_store($1, $2, $3, 10, $4, null, $5) as r", [org, sent.id, admin.id, "b".repeat(64), fingerprint])).r.status),
    ).toBe("stored");
  });

  it("goes with its record: a merge moves it; a purge leaves it detached (219 ב), read by owners, admins and managers", async () => {
    const keep = await newContact(owner, org, "שמור");
    const dup = await newContact(owner, org, "כפול");
    const sent = await send(owner, org, dup);
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, dup]));
    expect(await asAdmin(async (q) => (await one<{ c: string }>(q, "select contact_id as c from public.signature_documents where id = $1", [sent.id])).c)).toBe(keep);
    const fingerprint = (await page(sent.token)).fingerprint;
    expect((await sign(sent.token, { fingerprint })).status).toBe("signed");

    // a document is work: sample data and an import undo keep the record (any timeline entry is)
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and metadata ->> 'kind' = 'signature_sent'", [keep]))).toBe(1);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [keep]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [keep]));
    const detached = await asAdmin((q) =>
      one<Record<string, unknown>>(q, "select contact_id, former_contact_id, customer_deleted_at is not null as gone, status from public.signature_documents where id = $1", [sent.id]),
    );
    expect(detached).toEqual({ contact_id: null, former_contact_id: keep, gone: true, status: "signed" });
    expect(await asAdmin((q) => count(q, "select 1 from public.signature_signatures where document_id = $1 and signer_name is not null", [sent.id]))).toBe(1);
    // owners, admins and managers by role read it; a member, a viewer and an outsider do not
    const manager = await addMember(org, owner.id, "manager", "sg-manager");
    for (const u of [owner, admin, manager]) expect(await run(u, (q) => count(q, "select 1 from public.signature_documents where id = $1", [sent.id])), u.email).toBe(1);
    for (const u of [member, viewer, outsider]) expect(await run(u, (q) => count(q, "select 1 from public.signature_documents where id = $1", [sent.id])), u.email).toBe(0);
    // its link answers not found
    await notFound(sent.token);
    // the erasure after it empties it
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, keep]));
    const erased = await asAdmin((q) => one<{ body: string; signer: string | null }>(q, "select d.body, s.signer_name as signer from public.signature_documents d join public.signature_signatures s on s.document_id = d.id where d.id = $1", [sent.id]));
    expect(erased).toEqual({ body: "המסמך נמחק (מחיקת פרטיות)", signer: null });
    const left = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where entity_type = 'signature_documents' and entity_id = $1", [sent.id])).rows);
    expect(JSON.stringify(left)).not.toContain("דנה");
  });

  it("a business deleted whole takes its documents with it", async () => {
    const gone = await createUser("sg-gone");
    const orgG = await createOrg(gone.id, "עסק שנסגר");
    await setPlan(orgG, { signatures: true });
    await simplify(gone, orgG, "service_agreement", CONTACT_BODY);
    const tpl = await run(gone, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [orgG])).id);
    const contact = await newContact(gone, orgG, "לקוח");
    const sent = await send(gone, orgG, contact, { template: tpl });
    await asAdmin((q) => q("delete from public.organizations where id = $1", [orgG]));
    expect(await asAdmin((q) => count(q, "select 1 from public.signature_documents where id = $1", [sent.id]))).toBe(0);
  });

  it("another business reaches nothing: functions refuse across businesses", async () => {
    const contact = await newContact(member, org, "גבול");
    const sent = await send(member, org, contact);
    for (const sql of ["select public.signature_document_link($1, $2)", "select public.signature_document_cancel($1, $2)", "select public.signature_pdf_allowed($1, $2)"]) {
      expect((await pgError(run(outsider, (q) => q(sql, [org, sent.id])))).code, sql).toBe("42501");
    }
    // naming its own business with another's document
    for (const sql of ["select public.signature_document_link($1, $2)", "select public.signature_document_cancel($1, $2)"]) {
      expect((await pgError(run(outsider, (q) => q(sql, [otherOrg, sent.id])))).code, sql).toBe("42501");
    }
    expect((await pgError(send(outsider, otherOrg, contact))).code).toBe("42501");
    expect(await run(outsider, async (q) => (await one<{ r: unknown }>(q, "select public.signature_pdf_allowed($1, $2) as r", [otherOrg, sent.id])).r)).toBeNull();
  });

  // ---------------------------------------------------------------------------------------------------------------------
  // Review of 10 November 2026
  // ---------------------------------------------------------------------------------------------------------------------
  const newDeal = async (u: U, contact: string | null, name = "עסקת שירות") => {
    const { pipelineId, stages } = await defaultPipeline(org);
    const open = stages.find((s) => s.kind === "open") ?? stages[0];
    return run(u, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, $2, $3, $4, $5, $6) returning id", [
          org,
          name,
          pipelineId,
          open.id,
          contact,
          u.id,
        ])
      ).id,
    );
  };
  const newTemplate = (recordType: string) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.document_templates (organization_id, name, kind, record_type, body) values ($1, $2, 'other', $3, 'מסמך לחתימה') returning id", [
          org,
          `תבנית ${recordType} ${Math.random().toString(36).slice(2, 8)}`,
          recordType,
        ])
      ).id,
    );
  // signs a document and keeps its signed PDF (an object at the path the database hands out)
  const signAndStore = async (token: string, opts: { name?: string; id?: string } = {}) => {
    const fingerprint = (await page(token)).fingerprint as string;
    expect((await sign(token, { fingerprint, name: opts.name ?? "דנה כהן", id: opts.id ?? "000000018", ip: "198.51.100.7", ua: "Agent/erase" })).status).toBe("signed");
    const store = (path: string | null) =>
      asService(async (q) => (await one<{ r: { status: string; path?: string; file_id?: string } }>(q, "select public.signature_pdf_public_store($1, 1234, $2, $3, $4) as r", [token, "b".repeat(64), path, fingerprint])).r);
    const first = await store(null);
    await asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [first.path]);
      await q("update storage.objects set metadata = jsonb_build_object('size', 1234::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [first.path]);
    });
    const done = await store(first.path ?? null);
    expect(done.status).toBe("stored");
    return { fileId: done.file_id as string, path: first.path as string };
  };
  // nothing personal is left anywhere on the document's side
  const expectErased = async (docId: string, file: { fileId: string; path: string }, token: string, recordId: string, title: string) => {
    const doc = await asAdmin((q) => one<{ body: string; title: string; erased_at: string | null }>(q, "select body, title, erased_at from public.signature_documents where id = $1", [docId]));
    expect(doc.body).toBe("המסמך נמחק (מחיקת פרטיות)");
    expect(doc.title).not.toBe(title);
    expect(doc.erased_at).not.toBeNull();
    const sig = await asAdmin((q) => one<Record<string, unknown>>(q, "select signer_name, signer_id_number, signature_image, ip, user_agent, erased_at from public.signature_signatures where document_id = $1", [docId]));
    expect(sig).toMatchObject({ signer_name: null, signer_id_number: null, signature_image: null, ip: null, user_agent: null });
    expect(sig.erased_at).not.toBeNull();
    const entries = await asAdmin(async (q) => (await q<{ id: string; body: string }>("select id, body from public.activities where metadata ->> 'signature_document_id' = $1", [docId])).rows);
    expect(entries.length).toBeGreaterThan(0);
    expect(JSON.stringify(entries)).not.toContain(title);
    const entryAudit = await asAdmin(async (q) => (await q<{ changes: unknown }>("select changes from public.audit_log where entity_type = 'activities' and entity_id = any ($1::uuid[])", [entries.map((e) => e.id)])).rows);
    expect(JSON.stringify(entryAudit)).not.toContain(title);
    const notices = await asAdmin(async (q) => (await q<{ body: string }>("select body from public.notifications where entity_id = $1 and title = 'מסמך נחתם בקישור'", [recordId])).rows);
    expect(notices.length).toBeGreaterThan(0);
    expect(JSON.stringify(notices)).not.toContain(title);
    // the signed PDF (the pasted 021213): its row goes, its object waits for the orphan cleanup
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [file.fileId]))).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [file.path]))).toBe(1);
    // the link answers not found; no new PDF is made for it
    await notFound(token);
    const allowed = await run(owner, (q) => one<{ r: unknown }>(q, "select public.signature_pdf_allowed($1, $2) as r", [org, docId])).catch(() => null);
    expect(allowed?.r ?? null).toBeNull();
    const everything = await asAdmin(async (q) =>
      JSON.stringify((await q("select d.*, s.* from public.signature_documents d left join public.signature_signatures s on s.document_id = d.id where d.id = $1", [docId])).rows),
    );
    for (const text of ["דנה כהן", "000000018", "198.51.100.7", "Agent/erase", title]) expect(everything, text).not.toContain(text);
  };

  it("review 1: a contact's erasure empties the documents of its deal (body, signature, timeline, notices, signed PDF)", async () => {
    const contact = await newContact(member, org, "דנה");
    const deal = await newDeal(member, contact);
    const title = "חוזה עם דנה כהן 050-1234567";
    const sent = await send(member, org, deal, { template: dealTemplate, type: "deal", title, extra: "חוזה בין העסק לבין דנה כהן, 050-1234567" });
    const people = await asAdmin(async (q) => (await one<{ p: string[] }>(q, "select people as p from public.signature_documents where id = $1", [sent.id])).p);
    expect(people).toContain(contact);
    const file = await signAndStore(sent.token);
    // a person's own export reaches the object (the ZIP downloads it with the owner's session); a member does not
    expect(await run(owner, (q) => count(q, "select 1 from storage.objects where bucket_id = 'record-files' and name = $1", [file.path]))).toBe(1);
    expect(await run(member, (q) => count(q, "select 1 from storage.objects where bucket_id = 'record-files' and name = $1", [file.path]))).toBe(0);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [contact]));
    // the deal and its document stay until the erasure
    expect(await asAdmin((q) => count(q, "select 1 from public.signature_documents where id = $1 and erased_at is null", [sent.id]))).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    await expectErased(sent.id, file, sent.token, deal, title);
    // the deal itself is kept
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1", [deal]))).toBe(1);
  });

  it("review 1: a contact's erasure empties a company document it is named in", async () => {
    const companyTemplate = await newTemplate("company");
    const company = await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברת החתימות', $2) returning id", [org, owner.id])).id);
    const contact = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, company_id, owner_id) values ($1, 'דנה', $2, $3) returning id", [org, company, owner.id])).id,
    );
    const title = "הסכם חברה, חותמת דנה כהן";
    const sent = await send(owner, org, company, { template: companyTemplate, type: "company", title, extra: "הסכם עם החברה" });
    const file = await signAndStore(sent.token);
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [contact]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    await expectErased(sent.id, file, sent.token, company, title);
  });

  it("review 1: PRV-03's removal of a person reaches the documents of the person's deal", async () => {
    const contact = await newContact(owner, org, "דנה");
    const deal = await newDeal(owner, contact, "עסקה כללית");
    const title = "חוזה פרטי לדנה כהן";
    const sent = await send(owner, org, deal, { template: dealTemplate, type: "deal", title, extra: "חוזה בין העסק לבין דנה כהן" });
    const file = await signAndStore(sent.token);
    await asMfaUser(owner.id, (q) => q("select public.privacy_erase_person($1, 'contacts', $2, '[]'::jsonb, 'הלקוחה ביקשה', '{}'::jsonb, true)", [org, contact]));
    expect(await asAdmin((q) => count(q, "select 1 from public.contacts where id = $1", [contact]))).toBe(0);
    await expectErased(sent.id, file, sent.token, deal, title);
  });

  it("review 2: the retention policy keeps a lead that holds a signed document", async () => {
    const leadTemplate = await newTemplate("lead");
    const lead = await insertLead(owner.id, org, { full_name: "ליד חתום" });
    await asAdmin(async (q) => {
      await q("set local session_replication_role = replica");
      await q("update public.leads set created_at = now() - interval '3 years' where id = $1", [lead]);
    });
    const candidate = () => asAdmin((q) => count(q, "select 1 from app.lead_retention_candidates($1, now() - interval '1 year', $2)", [org, lead]));
    expect(await candidate()).toBe(1);
    const sent = await send(owner, org, lead, { template: leadTemplate, type: "lead" });
    // sent but not signed: the policy may still take it (owner question 219 is about signed documents)
    expect(await candidate()).toBe(1);
    const fingerprint = (await page(sent.token)).fingerprint as string;
    expect((await sign(sent.token, { fingerprint })).status).toBe("signed");
    expect(await candidate()).toBe(0);
  });

  it("review 3 and 5: only a registered wording is signed; a changed render abandons only this document's own upload paths", async () => {
    const contact = await newContact(member, org, "נוסח");
    const sent = await send(member, org, contact);
    const fingerprint = (await page(sent.token)).fingerprint as string;
    expect((await sign(sent.token, { fingerprint, wording: "sign-draft-0000-01-01" })).status).toBe("invalid");
    expect(await asAdmin((q) => count(q, "select 1 from public.signature_signatures where document_id = $1", [sent.id]))).toBe(0);
    expect((await sign(sent.token, { fingerprint })).status).toBe("signed");
    const source = await asService(async (q) => (await one<{ r: { signature: Record<string, unknown> } }>(q, "select public.signature_pdf_public($1) as r", [sent.token])).r);
    expect(source.signature.wording).toBe("קראתי את המסמך ואני מאשר/ת את תוכנו. החתימה שלי כאן מחייבת כמו חתימה בכתב יד.");

    // someone else's path named with a stale fingerprint is never handed to the orphan cleanup
    const foreign = `${org}/${"00000000-0000-4000-8000-00000000abcd"}`;
    const changed = await asService(async (q) => (await one<{ r: { status: string } }>(q, "select public.signature_pdf_public_store($1, 1234, $2, $3, $4) as r", [sent.token, "c".repeat(64), foreign, "9".repeat(64)])).r);
    expect(changed.status).toBe("changed");
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [foreign]))).toBe(0);
    // its own open attempt is
    const first = await asService(async (q) => (await one<{ r: { path: string } }>(q, "select public.signature_pdf_public_store($1, 1234, $2, null, $3) as r", [sent.token, "c".repeat(64), fingerprint])).r);
    await asService((q) => q("select public.signature_pdf_public_store($1, 1234, $2, $3, $4)", [sent.token, "c".repeat(64), first.path, "9".repeat(64)]));
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [first.path]))).toBe(1);
  });

  it("(223) ב: after signing, the customer downloads the signed PDF through the link it was signed with, 20 per sender", async () => {
    const contact = await newContact(member, org, "הורדה");
    const sent = await send(member, org, contact);
    const pdf = (token: string, ip: string | null = "hash-1") =>
      asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.signature_public_pdf($1, $2) as r", [token, ip])).r);
    // not signed yet: not found
    expect((await pgError(pdf(sent.token))).code).toBe("P0002");
    expect((await pgError(pdf("x".repeat(64)))).code).toBe("P0002");
    const fingerprint = (await page(sent.token)).fingerprint as string;
    expect((await sign(sent.token, { fingerprint })).status).toBe("signed");
    // signed, the PDF not kept yet
    expect(await pdf(sent.token)).toEqual({ unavailable: true });
    const store = (path: string | null) =>
      asService(async (q) => (await one<{ r: { status: string; path?: string } }>(q, "select public.signature_pdf_public_store($1, 1234, $2, $3, $4) as r", [sent.token, "d".repeat(64), path, fingerprint])).r);
    const first = await store(null);
    await asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [first.path]);
      await q("update storage.objects set metadata = jsonb_build_object('size', 1234::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [first.path]);
    });
    expect((await store(first.path ?? null)).status).toBe("stored");
    const answer = await pdf(sent.token);
    expect(Object.keys(answer).sort()).toEqual(["name", "path", "sha256"]);
    expect(answer).toMatchObject({ path: first.path, sha256: "d".repeat(64) });
    // only service_role
    expect((await pgError(run(owner, (q) => q("select public.signature_public_pdf($1, null)", [sent.token])))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.signature_public_pdf($1, null)", [sent.token])))).code).toBe("42501");
    // only the link it was signed with: a token hash that is not the signing one answers not found
    await asAdmin((q) => q("update app.signature_links set signed_token_hash = repeat('0', 64) where document_id = $1", [sent.id]));
    expect((await pgError(pdf(sent.token))).code).toBe("P0002");
    await asAdmin((q) => q("update app.signature_links set signed_token_hash = token_hash where document_id = $1", [sent.id]));
    // 20 per sender in 10 minutes; another sender is still served; no hash = not counted
    for (let i = 1; i < 20; i += 1) expect((await pdf(sent.token, "hash-2")).path).toBe(first.path);
    expect((await pdf(sent.token, "hash-2")).path).toBe(first.path);
    expect(await pdf(sent.token, "hash-2")).toEqual({ rate_limited: true });
    expect((await pdf(sent.token, "hash-3")).path).toBe(first.path);
    expect((await pdf(sent.token, null)).path).toBe(first.path);
    // the counter keeps no hash
    expect(JSON.stringify(await asAdmin(async (q) => (await q("select * from app.signature_pdf_download_counts where document_id = $1", [sent.id])).rows))).not.toContain("hash-2");
  });

  it("(224) ב: the sender edits the free text; locked sections and filled values stay, in order; the template marks them", async () => {
    const contact = await newContact(member, org, "עריכה");
    const d = await draft(member, org, template, "contact", contact);
    expect(d.segments.map((seg) => seg.locked)).toEqual([false, true, false]);
    expect(d.segments[1].text).toBe("סעיף קבוע: עסק החתימות אחראי לשירות.");
    expect(d.unfilled).toEqual([]);
    const [free, locked, tail] = d.segments.map((seg) => seg.text);
    // free text edited around the values: allowed, and what is sent is what the customer reads
    const edited = `${free.replace("ההסכם נערך", "ההסכם המעודכן נערך")}\nתוספת חופשית\n${locked}\n${tail} ונשמח לעבוד יחד.`;
    const ok1 = await send(member, org, contact, { body: edited });
    expect((await page(ok1.token)).document?.body).toBe(edited);
    // a locked section changed, removed, or moved before a value: refused
    for (const body of [
      `${free}\n${locked.replace("אחראי", "לא אחראי")}\n${tail}`,
      `${free}\n${tail}`,
      `${locked}\n${free}\n${tail}`,
      // a filled value changed in the free text
      `${free.replace("עריכה", "מישהו אחר")}\n${locked}\n${tail}`,
      // review 1: text on the locked section's own lines (before, after, or marks around it)
      `${free}\nלא ${locked}\n${tail}`,
      `${free}\n${locked} למעט כל האמור לעיל\n${tail}`,
      `${free}\n**${locked}**\n${tail}`,
      `${free} ${locked}\n${tail}`,
    ]) {
      expect((await pgError(send(member, org, contact, { body }))).hint, body).toBe("signature_document:locked_changed");
    }
    // delta review: a direction or invisible character anywhere is refused (an RLO line right before the locked section,
    // a zero-width space in the free text, a line separator, an isolate), in the text and in the title
    for (const mark of ["\u202E", "\u200B", "\u2028", "\u2066", "\u200F"]) {
      expect((await pgError(send(member, org, contact, { body: `${free}\n${mark}\n${locked}\n${tail}` }))).hint, `body ${mark.codePointAt(0)}`).toBe(
        "signature_document:invisible",
      );
      expect((await pgError(send(member, org, contact, { title: `חוזה${mark}` }))).hint, `title ${mark.codePointAt(0)}`).toBe("signature_document:invisible");
    }
    // a record value copied from a phone with direction marks is filled cleanly, and the document sends
    const marked = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, "\u200Fנועה\u200E", member.id])).id,
    );
    const clean = await draft(member, org, template, "contact", marked);
    const cleanBody = clean.segments.map((seg) => seg.text).join("\n");
    expect(cleanBody).toContain("לבין נועה.");
    expect(cleanBody).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/);
    const sentMarked = await send(member, org, marked);
    expect(await asAdmin(async (q) => (await one<{ b: string }>(q, "select body as b from public.signature_documents where id = $1", [sentMarked.id])).b)).toBe(cleanBody);
    // a field the record has no value for stops sending even when the sender deletes it
    const phoneTemplate = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.document_templates (organization_id, name, kind, record_type, body) values ($1, 'עם טלפון', 'other', 'contact', 'הטלפון: {טלפון}.') returning id", [org])).id,
    );
    expect((await draft(member, org, phoneTemplate, "contact", contact)).unfilled).toEqual(["טלפון"]);
    expect((await pgError(send(member, org, contact, { template: phoneTemplate, body: "הטלפון: ." }))).hint).toBe("signature_document:unfilled");
    // the draft has the sending rights: another member who may not edit the record is refused
    expect((await pgError(draft(other, org, template, "contact", contact))).code).toBe("42501");
    // the template check refuses a malformed locked section
    for (const body of ["::: נעול\nבלי סוף", ":::\nסוף בלי התחלה", "::: נעול\n::: נעול\nא\n:::\n:::", "::: נעול\n   \n:::"]) {
      expect(
        (await pgError(run(owner, (q) => q("insert into public.document_templates (organization_id, name, kind, record_type, body) values ($1, $2, 'other', 'contact', $3)", [org, `שבור ${Math.random()}`, body])))).hint,
        body,
      ).toBe("document_template:locked");
    }
  });

  it("(224) ב: the locked sections and the gender pick run the shared fixtures as the app", async () => {
    const locked = JSON.parse(readFileSync(path.join(__dirname, "../unit/fixtures/document-locked-sections.json"), "utf8")) as {
      body: string;
      problem: string | null;
      segments?: { locked: boolean; text: string }[];
    }[];
    for (const c of locked) {
      const r = await asAdmin(async (q) => (await one<{ r: { problem: string | null; segments?: unknown } }>(q, "select app.document_locked_segments($1) as r", [c.body])).r);
      expect(r.problem, c.body).toBe(c.problem);
      if (c.problem === null) expect(r.segments, c.body).toEqual(c.segments);
    }
    const variants = JSON.parse(readFileSync(path.join(__dirname, "../unit/fixtures/gender-variants.json"), "utf8")) as {
      text: string;
      problem: string | null;
      male: string;
      female: string;
      neutral: string;
    }[];
    for (const c of variants.filter((v) => v.problem === null)) {
      for (const gender of ["male", "female", "neutral"] as const) {
        const r = await asAdmin(async (q) => (await one<{ r: string }>(q, "select app.document_pick_variants($1, $2) as r", [c.text, gender === "neutral" ? null : gender])).r);
        expect(r, `${c.text} ${gender}`).toBe(c[gender]);
      }
    }
    // a value is put in as literal text in the cleaned Markdown, the same marks escaped as markdownLiteral()
    for (const value of ["a*b [c](d) #e_f `g` -h \\ i", "שורה\n  שנייה", "רגיל"]) {
      const r = await asAdmin(async (q) => (await one<{ r: string }>(q, "select app.document_literal($1) as r", [value])).r);
      expect(r, value).toBe(markdownLiteral(value));
    }
  });


  it("review 2: erasing a purged deal or company empties its own detached documents", async () => {
    const companyTemplate = await newTemplate("company");
    for (const kind of ["deal", "company"] as const) {
      const record =
        kind === "deal"
          ? await newDeal(owner, null, "עסקה למחיקה")
          : await run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברה למחיקה', $2) returning id", [org, owner.id])).id);
      const title = `מסמך ${kind} עם דנה כהן`;
      const sent = await send(owner, org, record, { template: kind === "deal" ? dealTemplate : companyTemplate, type: kind, title, extra: "דנה כהן חותמת" });
      const file = await signAndStore(sent.token);
      const table = kind === "deal" ? "deals" : "companies";
      await run(owner, (q) => q(`update public.${table} set deleted_at = now() where id = $1`, [record]));
      await run(owner, (q) => q(`delete from public.${table} where id = $1`, [record]));
      const detached = await asAdmin((q) => one<{ erased_at: string | null }>(q, "select erased_at from public.signature_documents where id = $1", [sent.id]));
      expect(detached.erased_at, kind).toBeNull();
      await run(owner, (q) => q("select public.audit_erase_record($1, $2, $3)", [org, table, record]));
      const doc = await asAdmin((q) => one<{ body: string; title: string }>(q, "select body, title from public.signature_documents where id = $1", [sent.id]));
      expect(doc.body, kind).toBe("המסמך נמחק (מחיקת פרטיות)");
      expect(doc.title, kind).not.toBe(title);
      const sig = await asAdmin((q) => one<Record<string, unknown>>(q, "select signer_name, signer_id_number, signature_image, ip, user_agent from public.signature_signatures where document_id = $1", [sent.id]));
      expect(sig, kind).toEqual({ signer_name: null, signer_id_number: null, signature_image: null, ip: null, user_agent: null });
      expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [file.fileId])), kind).toBe(0);
      expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [file.path])), kind).toBe(1);
    }
  });

  it("review 3 and 4: `people` is not selectable; an erased document gets no new link and no cancel", async () => {
    const contact = await newContact(member, org, "דנה");
    const deal = await newDeal(member, contact, "עסקה בלי חתימה");
    const sent = await send(member, org, deal, { template: dealTemplate, type: "deal" });
    // the readers read every other column, never `people`
    expect(await run(member, (q) => count(q, "select id, title, body from public.signature_documents where id = $1", [sent.id]))).toBe(1);
    expect((await pgError(run(owner, (q) => q("select people from public.signature_documents where id = $1", [sent.id])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("select * from public.signature_documents where id = $1", [sent.id])))).code).toBe("42501");
    // the person export's lookup: owners and admins only
    const naming = await run(owner, async (q) => (await one<{ r: string[] }>(q, "select public.signature_documents_naming($1, $2) as r", [org, [contact]])).r);
    expect(naming).toContain(sent.id);
    expect((await pgError(run(member, (q) => q("select public.signature_documents_naming($1, $2)", [org, [contact]])))).code).toBe("42501");
    expect((await pgError(run(outsider, (q) => q("select public.signature_documents_naming($1, $2)", [org, [contact]])))).code).toBe("42501");
    // the contact is erased: the deal's unsigned document is emptied, and no one makes a new link for it or cancels it
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [contact]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    expect(await asAdmin((q) => count(q, "select 1 from public.signature_documents where id = $1 and erased_at is not null", [sent.id]))).toBe(1);
    for (const sql of ["select public.signature_document_link($1, $2)", "select public.signature_document_cancel($1, $2)"]) {
      expect((await pgError(run(member, (q) => q(sql, [org, sent.id])))).hint, sql).toBe("signature_document:closed");
    }
    await notFound(sent.token);
  });

});

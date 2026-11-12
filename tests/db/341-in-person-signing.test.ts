import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const WORDING = "sign-draft-2026-11-10";
const QUOTE_WORDING = "draft-2026-10-18";
const BODY = "**הסכם שירות**\n\nההסכם נערך בין {שם העסק} לבין {שם פרטי}.";
const UA = "Mozilla/5.0 (Linux; Android 14) rep-tablet";

/**
 * SGN-07 (owner, 11 November 2026, answer (276) א): the customer signs on the rep's device. The rep's session is checked
 * first, only someone who may send the document (or quote) signs it in person, and the signature records that it was face
 * to face, the rep and the rep's browser (no IP). The signed PDF is written by the existing service_role writers, which also
 * write for that rep within the hour; the public link still works.
 */
describe("in-person signing (SGN-07)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let template: string;
  let pipe: { pipelineId: string; stageId: string };

  const run = <T,>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const can = async (role: string, fn: string) => (await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn]))).c;

  const newContact = (u: U, name: string, orgId = org) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [orgId, name, u.id])).id);
  const sendDoc = (u: U, contact: string) =>
    run(u, async (q) => {
      const d = (await one<{ d: { segments: { text: string }[] } }>(q, "select public.signature_document_draft($1, $2, 'contact', $3) as d", [org, template, contact])).d;
      return (
        await one<{ r: { id: string; token: string } }>(q, "select public.signature_document_send($1, $2, 'contact', $3, '', $4, null) as r", [
          org,
          template,
          contact,
          d.segments.map((s) => s.text).join("\n"),
        ])
      ).r;
    });
  const fingerprintOf = (doc: string) => asAdmin(async (q) => (await one<{ f: string }>(q, "select content_sha256 as f from public.signature_documents where id = $1", [doc])).f);
  const signInPerson = (u: U, doc: string, args: Record<string, unknown> = {}) =>
    run(u, async (q) =>
      (
        await one<{ r: { status: string } }>(
          q,
          `select public.signature_in_person_sign(p_org => $1, p_doc => $2, p_fingerprint => $3, p_signer_name => $4,
                   p_signature_kind => 'drawn', p_signature_image => $5, p_wording_version => $6, p_agreed => true,
                   p_user_agent => $7) as r`,
          [args.org ?? org, doc, args.fingerprint, args.name ?? "דנה כהן", PNG, args.wording ?? WORDING, UA],
        )
      ).r,
    );
  const putObject = (path: string) =>
    asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [path]);
      await q("update storage.objects set metadata = jsonb_build_object('size', 1234::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [path]);
    });

  const quoteLink = (u: U, quote: string) => run(u, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quote])).t);
  // a sent quote with its customer link (in-person signing needs a live link: its row carries the try counter)
  const newQuote = (u: U, withLink = true) =>
    run(u, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipe.pipelineId,
          pipe.stageId,
          u.id,
        ])
      ).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, position, name, quantity, unit_price_agorot) values ($1, $2, 1, 'עבודה', 1, 10000)", [org, id]);
      await q(
        "insert into public.quote_lines (organization_id, quote_id, position, name, quantity, unit_price_agorot, is_optional, optional_selected) values ($1, $2, 2, 'תוספת', 1, 5000, true, false)",
        [org, id],
      );
      await q("select public.quote_send($1, $2)", [org, id]);
      if (withLink) await q("select public.quote_link_create($1, $2)", [org, id]);
      return id;
    });
  const quoteOpen = (u: U, quote: string) => run(u, async (q) => (await one<{ r: { state: string; fingerprint: string | null } }>(q, "select public.quote_in_person_open($1, $2) as r", [org, quote])).r);
  const acceptInPerson = (u: U, quote: string, fingerprint: string, keys: number[] | null, total: number | null) =>
    run(u, async (q) =>
      (
        await one<{ r: { status: string } }>(
          q,
          `select public.quote_in_person_accept(p_org => $1, p_quote => $2, p_fingerprint => $3, p_signer_name => 'נועה לוי',
                   p_signature_kind => 'drawn', p_signature_image => $4, p_wording_version => $5, p_agreed => true,
                   p_user_agent => $6, p_optional_keys => $7::integer[], p_accepted_total_agorot => $8) as r`,
          [org, quote, fingerprint, PNG, QUOTE_WORDING, UA, keys, total],
        )
      ).r,
    );
  const acceptPublic = async (token: string, keys: number[] | null, total: number | null) => {
    const fp = (await asService(async (q) => (await one<{ v: { fingerprint: string } }>(q, "select public.quote_public_version($1) as v", [token])).v)).fingerprint;
    return asService(async (q) =>
      (
        await one<{ a: { status: string } }>(
          q,
          `select public.quote_public_answer(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה לוי',
                    p_signature_kind => 'drawn', p_signature_image => $3, p_wording_version => $4, p_agreed => true,
                    p_ip => '192.0.2.10', p_user_agent => $5, p_optional_keys => $6::integer[], p_accepted_total_agorot => $7) as a`,
          [token, fp, PNG, QUOTE_WORDING, UA, keys, total],
        )
      ).a,
    );
  };

  beforeAll(async () => {
    owner = await createUser("ip-owner");
    org = await createOrg(owner.id, "עסק החתימה במקום");
    admin = await addMember(org, owner.id, "admin", "ip-admin");
    member = await addMember(org, owner.id, "member", "ip-member");
    other = await addMember(org, owner.id, "member", "ip-other");
    viewer = await addMember(org, owner.id, "viewer", "ip-viewer");
    outsider = await createUser("ip-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    for (const o of [org, otherOrg]) {
      await asAdmin((q) =>
        q(
          "update public.subscriptions set feature_overrides = '{\"signatures\": true}'::jsonb, limit_overrides = '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1",
          [o],
        ),
      );
    }
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    await run(owner, (q) => q("update public.document_templates set body = $2 where organization_id = $1 and key = 'service_agreement'", [org, BODY]));
    template = await run(owner, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'service_agreement'", [org])).id);
    await run(owner, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages.find((s) => s.kind === "open")!.id };
  });

  it("the new functions are for signed-in people; the helpers for no role; the marks are server-only", async () => {
    for (const fn of [
      "public.signature_in_person_sign(uuid, uuid, text, text, text, text, text, text, boolean, text)",
      "public.signature_in_person_pdf_allowed(uuid, uuid)",
      "public.quote_in_person_open(uuid, uuid)",
      "public.quote_in_person_accept(uuid, uuid, text, text, text, text, text, text, boolean, text, integer[], bigint)",
      "public.quote_in_person_pdf_allowed(uuid, uuid)",
    ]) {
      expect(await can("anon", fn), fn).toBe(false);
      expect(await can("authenticated", fn), fn).toBe(true);
    }
    for (const fn of [
      "app.signature_in_person_rep(uuid, uuid, uuid)",
      "app.signature_pdf_user_may(uuid, uuid, uuid)",
      "app.quote_in_person_quote(uuid, uuid)",
      "app.quote_in_person_state(public.quotes)",
      "app.quote_in_person_rep(uuid, uuid, uuid)",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(await can(role, fn), `${fn} ${role}`).toBe(false);
    }
    for (const fn of ["public.signature_pdf_store(uuid, uuid, uuid, bigint, text, text, text)", "public.quote_signed_pdf_store(uuid, uuid, uuid, bigint, text, text, text, text)"]) {
      expect(await can("authenticated", fn), fn).toBe(false);
      expect(await can("service_role", fn), fn).toBe(true);
    }
    for (const t of ["signature_signatures", "quote_decisions"]) {
      for (const col of ["in_person", "in_person_by"]) {
        for (const priv of ["insert", "update"]) {
          expect(await asAdmin((q) => one<{ c: boolean }>(q, `select has_column_privilege('authenticated', 'public.${t}', $1, $2) as c`, [col, priv])), `${t}.${col}`).toEqual({ c: false });
        }
      }
    }
    expect((await pgError(asAnon((q) => q("select public.quote_in_person_open($1, $1)", [org])))).code).toBe("42501");
  });

  it("a document: only whoever may send it signs in person; the signature records the rep and the device, never an IP", async () => {
    const contact = await newContact(member, "דנה");
    const sent = await sendDoc(member, contact);
    const fingerprint = await fingerprintOf(sent.id);
    for (const u of [other, viewer]) expect((await pgError(signInPerson(u, sent.id, { fingerprint }))).code, u.email).toBe("42501");
    expect((await pgError(signInPerson(outsider, sent.id, { fingerprint, org: otherOrg }))).code).toBe("42501");
    expect((await pgError(signInPerson(outsider, sent.id, { fingerprint }))).code).toBe("42501");
    expect((await signInPerson(member, sent.id, { fingerprint: "0".repeat(64) })).status).toBe("changed");
    expect((await signInPerson(member, sent.id, { fingerprint, wording: "no-such-version" })).status).toBe("invalid");
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and title = 'מסמך נחתם בקישור'", [org]))).toBe(0);

    expect((await signInPerson(member, sent.id, { fingerprint })).status).toBe("signed");
    const sig = await asAdmin((q) => one<Record<string, unknown>>(q, "select in_person, in_person_by, ip, user_agent, signer_name from public.signature_signatures where document_id = $1", [sent.id]));
    expect(sig).toEqual({ in_person: true, in_person_by: member.id, ip: null, user_agent: UA, signer_name: "דנה כהן" });
    const doc = await asAdmin((q) => one<{ status: string }>(q, "select status from public.signature_documents where id = $1", [sent.id]));
    expect(doc.status).toBe("signed");
    // the timeline says it was in person; the notice goes to the sender and the record's owner, never the rep (here both)
    const entry = await asAdmin((q) => one<{ body: string; created_by: string }>(q, "select body, created_by from public.activities where metadata ->> 'signature_document_id' = $1 and metadata ->> 'kind' = 'signature_signed'", [sent.id]));
    expect(entry.body).toBe("הלקוח חתם על המסמך במקום: הסכם שירות");
    expect(entry.created_by).toBe(member.id);
    // (289) ב: the rep would have been the only one, so the active owners and admins are told instead (never the rep)
    const told = await asAdmin(async (q) => (await q<{ user_id: string; body: string }>("select user_id, body from public.notifications where organization_id = $1 and title = 'מסמך נחתם בקישור' and entity_id = $2 order by user_id", [org, contact])).rows);
    expect(told).toEqual([owner.id, admin.id].sort().map((user_id) => ({ user_id, body: "הסכם שירות" })));
    const audit = await asAdmin((q) => one<{ actor_id: string; changes: Record<string, unknown> }>(q, "select actor_id, changes from public.audit_log where entity_id = $1 and action = 'in_person_signature'", [sent.id]));
    expect(audit).toEqual({ actor_id: member.id, changes: { status: "signed", in_person: true, record_type: "contact" } });

    // an owner signing in person a member's document: the member (sender and owner of the record) is told, the title only
    const second = await sendDoc(member, await newContact(member, "יעל"));
    expect((await signInPerson(owner, second.id, { fingerprint: await fingerprintOf(second.id) })).status).toBe("signed");
    const told2 = await asAdmin(async (q) => (await q<{ user_id: string; body: string }>("select n.user_id, n.body from public.notifications n join public.signature_documents d on d.contact_id = n.entity_id where n.organization_id = $1 and n.title = 'מסמך נחתם בקישור' and d.id = $2", [org, second.id])).rows);
    expect(told2).toEqual([{ user_id: member.id, body: "הסכם שירות" }]);
    expect((await asAdmin((q) => one<{ b: string }>(q, "select in_person_by as b from public.signature_signatures where document_id = $1", [second.id]))).b).toBe(owner.id);

    // once only; the customer's link shows it signed and refuses a second signature
    expect((await signInPerson(member, sent.id, { fingerprint })).status).toBe("already_signed");
    const page = await asService(async (q) => (await one<{ p: { document: { status: string }; fingerprint: string | null } }>(q, "select public.signature_public($1, null) as p", [sent.token])).p);
    expect(page.document.status).toBe("signed");
    expect(page.fingerprint).toBeNull();
    const publicSign = await asService(async (q) =>
      (
        await one<{ r: { status: string } }>(
          q,
          "select public.signature_public_sign(p_token => $1, p_fingerprint => $2, p_signer_name => 'אחר', p_signature_kind => 'typed', p_wording_version => $3, p_agreed => true) as r",
          [sent.token, fingerprint, WORDING],
        )
      ).r,
    );
    expect(publicSign.status).toBe("already_signed");
  });

  it("a document's signed PDF: the rep who was there, within the hour, through the existing writer; no one else beyond owners and admins", async () => {
    const contact = await newContact(member, "רון");
    const sent = await sendDoc(member, contact);
    const fingerprint = await fingerprintOf(sent.id);
    expect((await signInPerson(member, sent.id, { fingerprint })).status).toBe("signed");
    // the rep's session answers the source, which says it was in person and names the rep
    const source = await run(member, async (q) => (await one<{ r: { signature: Record<string, unknown>; document: { fingerprint: string } } }>(q, "select public.signature_in_person_pdf_allowed($1, $2) as r", [org, sent.id])).r);
    expect(source.signature).toMatchObject({ in_person: true, in_person_by_name: "ip-member", signer_name: "דנה כהן" });
    expect(JSON.stringify(source)).not.toContain("rep-tablet");
    // nobody else through the in-person path (an owner keeps the staff path)
    for (const u of [other, viewer, owner, admin]) expect((await pgError(run(u, (q) => q("select public.signature_in_person_pdf_allowed($1, $2)", [org, sent.id])))).code, u.email).toBe("42501");
    // the existing store writes for that rep
    const store = (u: U, path: string | null) =>
      asService(async (q) => (await one<{ r: { status: string; path?: string } }>(q, "select public.signature_pdf_store($1, $2, $3, 1234, $4, $5, $6) as r", [org, sent.id, u.id, "c".repeat(64), path, source.document.fingerprint])).r);
    expect((await pgError(store(other, null))).code).toBe("42501");
    expect((await pgError(store(viewer, null))).code).toBe("42501");
    const first = await store(member, null);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    expect((await store(member, first.path!)).status).toBe("stored");
    expect(await run(member, async (q) => (await one<{ r: unknown }>(q, "select public.signature_in_person_pdf_allowed($1, $2) as r", [org, sent.id])).r)).toBeNull();

    // past the hour, or once the rep may no longer edit the record, the rep is refused again
    const later = await newContact(member, "גל");
    const doc2 = await sendDoc(member, later);
    expect((await signInPerson(member, doc2.id, { fingerprint: await fingerprintOf(doc2.id) })).status).toBe("signed");
    // (288) ב: 23 hours later the rep still may; past 24 hours not
    await asAdmin((q) => q("update public.signature_signatures set signed_at = now() - interval '23 hours' where document_id = $1", [doc2.id]));
    expect(await run(member, async (q) => (await one<{ r: unknown }>(q, "select public.signature_in_person_pdf_allowed($1, $2) as r", [org, doc2.id])).r)).not.toBeNull();
    await asAdmin((q) => q("update public.signature_signatures set signed_at = now() - interval '24 hours 1 minute' where document_id = $1", [doc2.id]));
    expect((await pgError(run(member, (q) => q("select public.signature_in_person_pdf_allowed($1, $2)", [org, doc2.id])))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select public.signature_pdf_store($1, $2, $3, 1234, $4)", [org, doc2.id, member.id, "c".repeat(64)])))).code).toBe("42501");
    const doc3Contact = await newContact(member, "שי");
    const doc3 = await sendDoc(member, doc3Contact);
    expect((await signInPerson(member, doc3.id, { fingerprint: await fingerprintOf(doc3.id) })).status).toBe("signed");
    await run(owner, (q) => q("update public.contacts set owner_id = $2 where id = $1", [doc3Contact, other.id]));
    expect((await pgError(asService((q) => q("select public.signature_pdf_store($1, $2, $3, 1234, $4)", [org, doc3.id, member.id, "c".repeat(64)])))).code).toBe("42501");
  });

  it("a quote: open state and fingerprint for whoever may send it; accepted in person exactly as on the customer's page", async () => {
    const quote = await newQuote(member);
    for (const u of [other, viewer]) expect((await pgError(quoteOpen(u, quote))).code, u.email).toBe("42501");
    expect((await pgError(run(outsider, (q) => q("select public.quote_in_person_open($1, $2)", [otherOrg, quote])))).code).toBe("42501");
    const open = await quoteOpen(member, quote);
    expect(open.state).toBe("open");
    expect(open.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await pgError(acceptInPerson(other, quote, open.fingerprint!, [2], 17550))).code).toBe("42501");
    expect((await acceptInPerson(member, quote, "1".repeat(64), [2], 17550)).status).toBe("changed");
    expect((await acceptInPerson(member, quote, open.fingerprint!, [2], 1)).status).toBe("changed");
    expect((await acceptInPerson(member, quote, open.fingerprint!, [1], null)).status).toBe("invalid");

    // a twin quote accepted through the customer's link, for comparison
    const twin = await newQuote(member, false);
    const token = await quoteLink(member, twin);
    const totalWithOption = await asAdmin(async (q) => (await one<{ t: string }>(q, "select (app.quote_counted_totals(q, q.vat_rate_bp, array(select id from public.quote_lines l where l.quote_id = q.id))->>'total_agorot') as t from public.quotes q where q.id = $1", [quote])).t);
    const total = Number(totalWithOption);
    expect((await acceptInPerson(member, quote, open.fingerprint!, [2], total)).status).toBe("accepted");
    expect((await acceptPublic(token, [2], total)).status).toBe("accepted");

    const row = (id: string) =>
      asAdmin((q) =>
        one<Record<string, unknown>>(
          q,
          `select q.status, q.subtotal_agorot, q.net_total_agorot, q.vat_agorot, q.total_agorot,
                  d.decision, d.signer_name, d.signature_kind, d.wording_version, d.user_agent, d.accepted_total_agorot, d.sent_total_agorot,
                  cardinality(d.optional_line_ids) as chosen,
                  (select count(*) from public.quote_lines l where l.quote_id = q.id and l.optional_selected)::int as selected
             from public.quotes q join public.quote_decisions d on d.quote_id = q.id where q.id = $1`,
          [id],
        ),
      );
    expect(await row(quote)).toEqual(await row(twin));
    const marks = await asAdmin((q) => one<Record<string, unknown>>(q, "select in_person, in_person_by, ip from public.quote_decisions where quote_id = $1", [quote]));
    expect(marks).toEqual({ in_person: true, in_person_by: member.id, ip: null });
    const twinMarks = await asAdmin((q) => one<Record<string, unknown>>(q, "select in_person, in_person_by from public.quote_decisions where quote_id = $1", [twin]));
    expect(twinMarks).toEqual({ in_person: null, in_person_by: null });
    // the timeline entry is the server's, as on the customer's page; the audit names the rep
    for (const id of [quote, twin]) {
      const entries = await asAdmin(async (q) => (await q<{ created_by: string | null }>("select created_by from public.activities where metadata ->> 'kind' = 'quote_accepted' and metadata ->> 'quote_id' = $1", [id])).rows);
      expect(entries, id).toEqual([{ created_by: null }]);
    }
    const audit = await asAdmin((q) => one<{ actor_id: string; changes: unknown }>(q, "select actor_id, changes from public.audit_log where entity_id = $1 and action = 'in_person_signature'", [quote]));
    expect(audit).toEqual({ actor_id: member.id, changes: { status: "accepted", in_person: true } });
    // the rep is never told of their own in-person acceptance
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and user_id = $2 and type = 'quote'", [quote, member.id]))).toBe(0);
    // (289) ב: the rep (the quote's owner) would have been the only one: the owners and admins are told instead
    const toldQuote = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where entity_id = $1 and title like 'הצעת מחיר אושרה במקום:%' order by user_id", [quote])).rows.map((r) => r.user_id));
    expect(toldQuote).toEqual([owner.id, admin.id].sort());
    expect((await quoteOpen(member, quote)).state).toBe("decided");
    expect((await acceptInPerson(member, quote, open.fingerprint!, [2], total)).status).toBe("already_decided");
  });

  it("a quote's signed PDF: the rep who was there, through the existing writer; a superseded quote is not signed", async () => {
    const quote = await newQuote(member);
    const open = await quoteOpen(member, quote);
    expect((await acceptInPerson(member, quote, open.fingerprint!, null, null)).status).toBe("accepted");
    const block = await run(member, async (q) => (await one<{ b: Record<string, unknown> }>(q, "select public.quote_in_person_pdf_allowed($1, $2) as b", [org, quote])).b);
    expect(block).toMatchObject({ in_person: true, in_person_by_name: "ip-member", signer_name: "נועה לוי" });
    for (const u of [other, viewer, owner]) expect((await pgError(run(u, (q) => q("select public.quote_in_person_pdf_allowed($1, $2)", [org, quote])))).code, u.email).toBe("42501");
    const store = (u: U) =>
      asService(async (q) => (await one<{ r: { status: string } }>(q, "select public.quote_signed_pdf_store($1, $2, $3, 20000, $4, 'הצעה חתומה.pdf', null, $5) as r", [org, quote, u.id, "d".repeat(64), block.fingerprint])).r);
    expect((await pgError(store(other))).code).toBe("42501");
    expect((await store(member)).status).toBe("upload");
    // owners and admins keep the staff block, which now carries the mark
    const staff = await run(owner, async (q) => (await one<{ b: Record<string, unknown> }>(q, "select public.quote_signed_pdf_allowed($1, $2) as b", [org, quote])).b);
    expect(staff).toMatchObject({ in_person: true, in_person_by_name: "ip-member" });

    // a newer version was sent: the older one is not signed in person
    const v1 = await newQuote(member);
    const v2 = await run(member, async (q) => (await one<{ id: string }>(q, "select public.quote_new_version($1, $2) as id", [org, v1])).id);
    await run(member, (q) => q("select public.quote_send($1, $2)", [org, v2]));
    expect((await quoteOpen(member, v1)).state).toBe("superseded");
    expect((await quoteOpen(member, v2)).state).toBe("no_link");
    await quoteLink(member, v2);
    expect((await quoteOpen(member, v2)).state).toBe("open");
  });

  it("review (low): a quote without a live customer link is not accepted in person (the link row carries the try counter)", async () => {
    const quote = await newQuote(member, false);
    expect(await quoteOpen(member, quote)).toEqual({ state: "no_link", fingerprint: null });
    const fingerprint = await asAdmin(async (q) => (await one<{ f: string }>(q, "select app.quote_fingerprint(q) as f from public.quotes q where q.id = $1", [quote])).f);
    expect((await acceptInPerson(member, quote, fingerprint, null, null)).status).toBe("closed");
    // a revoked link is not live either
    await quoteLink(member, quote);
    await run(member, (q) => q("select public.quote_link_revoke($1, $2)", [org, quote]));
    expect((await quoteOpen(member, quote)).state).toBe("no_link");
    expect((await acceptInPerson(member, quote, fingerprint, null, null)).status).toBe("closed");
    // with a live link, the counter applies: the eleventh try in 10 minutes is refused
    await quoteLink(member, quote);
    for (let i = 0; i < 10; i++) expect((await acceptInPerson(member, quote, "1".repeat(64), null, null)).status).toBe("changed");
    expect((await acceptInPerson(member, quote, fingerprint, null, null)).status).toBe("rate_limited");
    expect(await asAdmin((q) => count(q, "select 1 from public.quote_decisions where quote_id = $1", [quote]))).toBe(0);
  });

  it("review (high): the in-person notice is the one the erasure reaches; after it the notice holds no name", async () => {
    const dealTemplate = await run(owner, async (q) => (await one<{ id: string }>(q, "select id from public.document_templates where organization_id = $1 and key = 'contract'", [org])).id);
    await run(owner, (q) => q("update public.document_templates set body = 'חוזה עבור {שם העסקה}.' where id = $1", [dealTemplate]));
    const contact = await run(member, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, last_name, owner_id) values ($1, 'מירב', 'אורן', $2) returning id", [org, member.id])).id,
    );
    const deal = await run(member, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, contact_id) values ($1, 'עסקת שירות', $2, $3, $4, $5) returning id", [
          org,
          pipe.pipelineId,
          pipe.stageId,
          member.id,
          contact,
        ])
      ).id,
    );
    const title = "חוזה עם מירב אורן";
    const sent = await run(member, async (q) => {
      const d = (await one<{ d: { segments: { text: string }[] } }>(q, "select public.signature_document_draft($1, $2, 'deal', $3) as d", [org, dealTemplate, deal])).d;
      return (
        await one<{ r: { id: string } }>(q, "select public.signature_document_send($1, $2, 'deal', $3, $4, $5, null) as r", [
          org,
          dealTemplate,
          deal,
          title,
          d.segments.map((x) => x.text).join("\n"),
        ])
      ).r;
    });
    // the owner has the member's document signed in person: the member (sender, deal owner) is told, with the title
    expect((await signInPerson(owner, sent.id, { fingerprint: await fingerprintOf(sent.id), name: "מירב אורן" })).status).toBe("signed");
    const notice = () => asAdmin((q) => one<{ body: string }>(q, "select body from public.notifications where entity_id = $1 and user_id = $2 and title = 'מסמך נחתם בקישור'", [deal, member.id]));
    expect((await notice()).body).toBe(title);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [contact]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const after = (await notice()).body;
    expect(after).not.toContain("מירב");
    expect(after).not.toContain("אורן");
  });
});

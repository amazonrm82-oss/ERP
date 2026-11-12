import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asService, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";
import { migrationFile, rerunClosure } from "./rerun";

afterAll(closePool);

type U = { id: string; email: string };
type Store = { status: string; path?: string; file_id?: string };
type Pdf = { path?: string; sha256?: string; name?: string; unavailable?: boolean };
type Block = { signer_name: string; kind: string; image: string | null; decided_at: string; time_zone: string; wording_version: string; fingerprint: string };

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/**
 * QUO-09 signed PDF (owner, 1 November 2026, answers (3) א and (33) ב): when the customer accepts a quote, the server keeps a
 * signed PDF as a newer version of the quote's PDF as sent (files.previous_id; or the first file when none was kept). Written by
 * the server only: from the customer's route by the link's token (public.quote_signed_pdf_public / _public_store), or by staff
 * (public.quote_signed_pdf_allowed with their own session, then public.quote_signed_pdf_store for that user). Never counted
 * in max_pdf_per_month (owner (337) א); the customer downloads the newest confirmed version; staff read both; erasure removes every version.
 */
describe("the signed PDF of an accepted quote (QUO-09)", () => {
  let owner: U, admin: U, manager: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, outsiderOrg: string;
  let pipe: { pipelineId: string; stageId: string };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const sha = (c: string) => c.repeat(64);

  const newQuote = (u: U, optional = false) =>
    asUser(u.id, async (q) => {
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
      if (optional) {
        await q(
          "insert into public.quote_lines (organization_id, quote_id, position, name, quantity, unit_price_agorot, is_optional, optional_selected) values ($1, $2, 2, 'תוספת', 1, 5000, true, true)",
          [org, id],
        );
      }
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
  const putObject = (path: string, size = 20000) =>
    asAdmin(async (q) => {
      await q("insert into storage.objects (bucket_id, name) values ('record-files', $1) on conflict do nothing", [path]);
      await q("update storage.objects set metadata = jsonb_build_object('size', $2::bigint, 'mimetype', 'application/pdf') where bucket_id = 'record-files' and name = $1", [
        path,
        size,
      ]);
    });
  // the PDF as sent (QUO-06)
  const storeSent = async (u: U, quoteId: string, digest = sha("a")) => {
    const call = () =>
      asService(async (q) => (await one<{ r: Store }>(q, "select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעה.pdf') as r", [org, quoteId, u.id, digest])).r);
    const first = await call();
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    const second = await call();
    expect(second.status).toBe("stored");
    return { id: second.file_id!, path: first.path! };
  };
  const link = (u: U, quoteId: string) => asUser(u.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quoteId])).t);
  const version = (token: string) => asService(async (q) => (await one<{ v: { fingerprint: string | null; pdf_as_sent?: boolean } }>(q, "select public.quote_public_version($1) as v", [token])).v);
  const accept = async (token: string, keys: number[] | null = null, total: number | null = null) => {
    const fp = (await version(token)).fingerprint!;
    return asService(
      async (q) =>
        (
          await one<{ a: { status: string } }>(
            q,
            `select public.quote_public_answer(p_token => $1, p_decision => 'accepted', p_fingerprint => $2, p_signer_name => 'נועה לוי',
                      p_signature_kind => 'drawn', p_signature_image => $3, p_wording_version => 'draft-2026-10-18', p_agreed => true,
                      p_ip => '192.0.2.10', p_user_agent => 'Mozilla/5.0', p_optional_keys => $4::integer[], p_accepted_total_agorot => $5) as a`,
            [token, fp, PNG, keys, total],
          )
        ).a,
    );
  };
  const source = (token: string) => asService(async (q) => (await one<{ s: Record<string, unknown> }>(q, "select public.quote_signed_pdf_public($1) as s", [token])).s);
  const publicStore = (token: string, digest: string, path: string | null, fingerprint: string | null) =>
    asService(
      async (q) =>
        (await one<{ r: Store }>(q, "select public.quote_signed_pdf_public_store($1, 20000, $2, 'הצעה חתומה.pdf', $3, $4) as r", [token, digest, path, fingerprint])).r,
    );
  const staffAllowed = (u: U, quoteId: string, orgId = org) =>
    asUser(u.id, async (q) => (await one<{ b: Block | null }>(q, "select public.quote_signed_pdf_allowed($1, $2) as b", [orgId, quoteId])).b);
  const staffStore = (u: U, quoteId: string, digest: string, path: string | null, fingerprint: string | null, orgId = org) =>
    asService(
      async (q) =>
        (await one<{ r: Store }>(q, "select public.quote_signed_pdf_store($1, $2, $3, 20000, $4, 'הצעה חתומה.pdf', $5, $6) as r", [orgId, quoteId, u.id, digest, path, fingerprint])).r,
    );
  const signFully = async (token: string, digest: string, fingerprint: string) => {
    const first = await publicStore(token, digest, null, fingerprint);
    expect(first.status).toBe("upload");
    await putObject(first.path!);
    const second = await publicStore(token, digest, first.path!, fingerprint);
    expect(second.status).toBe("stored");
    return { id: second.file_id!, path: first.path! };
  };
  const files = (quoteId: string) =>
    asAdmin(
      async (q) =>
        (await q<{ id: string; previous_id: string | null; quote_signed: boolean | null; sha256: string }>(
          "select id, previous_id, quote_signed, sha256 from public.files where quote_id = $1 order by created_at, id",
          [quoteId],
        )).rows,
    );
  const download = (token: string) => asService(async (q) => (await one<{ p: Pdf }>(q, "select public.quote_public_pdf($1, null) as p", [token])).p);
  const views = (quoteId: string) => asAdmin(async (q) => (await q<{ view_count: number }>("select view_count from public.quote_views where quote_id = $1", [quoteId])).rows[0]?.view_count ?? 0);
  const produced = () =>
    asAdmin(async (q) => (await q<{ produced: number }>("select produced from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [org])).rows[0]?.produced ?? 0);
  const decisionFingerprint = (quoteId: string) =>
    asAdmin(async (q) => (await one<{ f: string }>(q, "select coalesce(choice_sha256, content_sha256) as f from public.quote_decisions where quote_id = $1", [quoteId])).f);

  beforeAll(async () => {
    owner = await createUser("qsg-owner");
    org = await createOrg(owner.id, "עסק החתימות");
    admin = await addMember(org, owner.id, "admin", "qsg-admin");
    manager = await addMember(org, owner.id, "manager", "qsg-manager");
    member = await addMember(org, owner.id, "member", "qsg-member");
    other = await addMember(org, owner.id, "member", "qsg-other");
    viewer = await addMember(org, owner.id, "viewer", "qsg-viewer");
    outsider = await createUser("qsg-outsider");
    outsiderOrg = await createOrg(outsider.id, "עסק אחר");
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    await asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{\"max_pdf_per_month\": 1000}'::jsonb where organization_id = $1", [org]),
    );
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const p = await defaultPipeline(org);
    pipe = { pipelineId: p.pipelineId, stageId: p.stages.find((s) => s.kind === "open")!.id };
  });

  it("the write functions are for service_role only; staff's right is for signed-in people; the marker is server-only", async () => {
    const can = async (role: string, fn: string) => (await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, $2, 'execute') as c", [role, fn]))).c;
    for (const fn of [
      "public.quote_signed_pdf_public(text)",
      "public.quote_signed_pdf_public_store(text, bigint, text, text, text, text)",
      "public.quote_signed_pdf_store(uuid, uuid, uuid, bigint, text, text, text, text)",
    ]) {
      expect(await can("anon", fn), fn).toBe(false);
      expect(await can("authenticated", fn), fn).toBe(false);
      expect(await can("service_role", fn), fn).toBe(true);
    }
    expect(await can("anon", "public.quote_signed_pdf_allowed(uuid, uuid)")).toBe(false);
    expect(await can("authenticated", "public.quote_signed_pdf_allowed(uuid, uuid)")).toBe(true);
    for (const fn of [
      "app.quote_signed_pdf_write(uuid, uuid, bigint, text, text, text, text)",
      "app.quote_signature_block(public.quotes)",
      "app.quote_signed_pdf_token_quote(text)",
      "app.quote_signed_pdf_done(public.quotes)",
    ]) {
      for (const role of ["anon", "authenticated", "service_role"]) expect(await can(role, fn), `${fn} ${role}`).toBe(false);
    }
    for (const priv of ["insert", "update"]) {
      expect(await asAdmin((q) => one<{ c: boolean }>(q, "select has_column_privilege('authenticated', 'public.files', 'quote_signed', $1) as c", [priv]))).toEqual({ c: false });
    }
    expect((await pgError(asUser(owner.id, (q) => q("select public.quote_signed_pdf_public('x')")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.quote_signed_pdf_public_store('x', 1, $1, 'x.pdf')", [sha("a")])))).code).toBe("42501");
  });

  it("after acceptance: the customer's route renders the page and stores the signed PDF after the PDF as sent; not counted (owner (337) א); no view counted", async () => {
    const quoteId = await newQuote(member, true);
    const sent = await storeSent(member, quoteId);
    const token = await link(member, quoteId);
    // not accepted yet: nothing to sign
    expect(await source(token)).toEqual({ unavailable: true });
    expect((await pgError(publicStore(token, sha("b"), null, sha("0")))).hint).toBe("quote_pdf:not_accepted");
    // the customer leaves the optional line out: the accepted total differs from the one sent
    const rate = (await asAdmin((q) => one<{ r: number }>(q, "select vat_rate_bp as r from public.quotes where id = $1", [quoteId]))).r;
    const total = 10000 + Math.floor((2 * 10000 * rate + 10000) / 20000);
    expect((await accept(token, [], total)).status).toBe("accepted");
    expect((await version(token)).pdf_as_sent).toBe(true);
    const viewsBefore = await views(quoteId);
    const src = (await source(token)) as { quote: { status: string; total_agorot: number }; lines: unknown[]; signature: Block };
    expect(await views(quoteId)).toBe(viewsBefore);
    expect(src.quote.status).toBe("accepted");
    expect(src.quote.total_agorot).toBe(total);
    expect(src.lines).toHaveLength(2);
    expect(src.signature).toMatchObject({ signer_name: "נועה לוי", kind: "drawn", image: PNG, wording_version: "draft-2026-10-18", time_zone: "Asia/Jerusalem" });
    expect(src.signature.fingerprint).toBe(await decisionFingerprint(quoteId));
    // never the ID number, the IP or the browser
    expect(JSON.stringify(src)).not.toContain("192.0.2.10");
    expect(JSON.stringify(src)).not.toContain("Mozilla");
    // owner (38) ב: a deal with neither contact nor company has no billing details
    expect((src as unknown as { billing: unknown }).billing).toEqual({ address: null, email: null, tax_id: null });

    // a render that printed another decision's fingerprint writes nothing
    expect(await publicStore(token, sha("c"), null, sha("f"))).toEqual({ status: "changed" });
    expect(await files(quoteId)).toHaveLength(1);

    const before = await produced();
    const signed = await signFully(token, sha("c"), src.signature.fingerprint);
    expect(await produced()).toBe(before);
    expect(await files(quoteId)).toEqual([
      { id: sent.id, previous_id: null, quote_signed: null, sha256: sha("a") },
      { id: signed.id, previous_id: sent.id, quote_signed: true, sha256: sha("c") },
    ]);
    // once: asked again it answers the same file, never another
    expect(await publicStore(token, sha("d"), null, src.signature.fingerprint)).toEqual({ status: "stored", file_id: signed.id });
    expect(await source(token)).toEqual({ done: true });
    expect(await staffAllowed(owner, quoteId)).toBeNull();
    expect(await produced()).toBe(before);

    // the customer gets the signed one, and the interim label is gone
    expect(await download(token)).toMatchObject({ path: signed.path, sha256: sha("c"), name: "הצעה חתומה.pdf" });
    expect((await version(token)).pdf_as_sent).toBeUndefined();
    // review (high), the safe side until the owner answers: owners and admins read both versions; anyone else who reads the
    // quote reads the PDF as sent only (a member who owns it; a viewer and a manager under org visibility), never the signed row
    // nor its object; another member under own visibility neither
    const rows = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.files where quote_id = $1", [quoteId]));
    const signedRows = (u: U) => asUser(u.id, (q) => count(q, "select 1 from public.files where quote_id = $1 and quote_signed", [quoteId]));
    const signedObject = (u: U) => asUser(u.id, (q) => count(q, "select 1 from storage.objects where bucket_id = 'record-files' and name = $1", [signed.path]));
    for (const u of [owner, admin]) {
      expect(await rows(u), u.email).toBe(2);
      expect(await signedObject(u), u.email).toBe(1);
    }
    expect(await rows(member)).toBe(1);
    expect(await signedRows(member)).toBe(0);
    expect(await signedObject(member)).toBe(0);
    expect(await rows(other)).toBe(0);
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    try {
      for (const u of [viewer, manager, other]) {
        expect(await rows(u), u.email).toBe(1);
        expect(await signedRows(u), u.email).toBe(0);
        expect(await signedObject(u), u.email).toBe(0);
      }
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    }
    // kept: nobody deletes either version
    for (const id of [sent.id, signed.id]) {
      expect((await pgError(asAdmin((q) => q("delete from public.files where id = $1", [id])))).hint).toBe("file:kept");
    }
    // the PDF as sent is never made again after the acceptance
    expect(
      await asService(async (q) => (await one<{ r: Store }>(q, "select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעה.pdf') as r", [org, quoteId, member.id, sha("e")])).r),
    ).toEqual({ status: "stored", file_id: sent.id });
  });

  it("owner (38) ב: the customer's route answers the quote's own customer's billing address, email and tax id, and nothing else", async () => {
    // a company and its contact, plus another contact of the same business whose details must never appear
    const { companyId, contactId, strangerId } = await asUser(member.id, async (q) => {
      const company = (await one<{ id: string }>(q, "insert into public.companies (organization_id, name, owner_id) values ($1, 'חברת אקמה', $2) returning id", [org, member.id])).id;
      const contact = (
        await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id, company_id) values ($1, 'דנה כהן', $2, $3) returning id", [org, member.id, company])
      ).id;
      const stranger = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'זר', $2) returning id", [org, member.id])).id;
      return { companyId: company, contactId: contact, strangerId: stranger };
    });
    await asAdmin(async (q) => {
      // the contact's own address; email and tax id come from its company (CON-08's effectiveBilling)
      await q("update public.contacts set billing_address = 'רחוב הרצל 5, חיפה', billing_name = 'שם לחיוב', shipping_address = 'משלוח 1', email = 'own@contact.example' where id = $1", [contactId]);
      await q("update public.companies set billing_address = 'כתובת החברה', billing_email = 'billing@acme.example', tax_id = '000000026', shipping_address = 'משלוח 2' where id = $1", [companyId]);
      await q("update public.contacts set billing_address = 'כתובת זרה', billing_email = 'stranger@x.example', billing_tax_id = '000000018' where id = $1", [strangerId]);
    });
    const onContact = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה לדנה', $2) returning id", [org, contactId])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const token = await link(member, onContact);
    expect((await accept(token)).status).toBe("accepted");
    const src = await source(token);
    expect(src.billing).toEqual({ address: "רחוב הרצל 5, חיפה", email: "billing@acme.example", tax_id: "000000026" });
    // the billing block holds exactly three fields; the name stays as printed when sent (customer.name, the page's own answer)
    expect(Object.keys(src.billing as object).sort()).toEqual(["address", "email", "tax_id"]);
    expect((src.customer as { name: string }).name).toBe("שם לחיוב");
    // no other customer field, nor another customer's
    const text = JSON.stringify(src);
    for (const leak of ["משלוח 1", "משלוח 2", "own@contact.example", "כתובת החברה", "כתובת זרה", "stranger@x.example", "000000018", contactId, companyId]) {
      expect(text, leak).not.toContain(leak);
    }
    // review: a company in the bin behind a live contact gives nothing; the contact's own value stays
    await asAdmin((q) => q("update public.companies set deleted_at = now() where id = $1", [companyId]));
    try {
      expect((await source(token)).billing).toEqual({ address: "רחוב הרצל 5, חיפה", email: null, tax_id: null });
    } finally {
      await asAdmin((q) => q("update public.companies set deleted_at = null where id = $1", [companyId]));
    }
    // the contact's own tax id wins over its company's
    await asAdmin((q) => q("update public.contacts set billing_tax_id = '000000018', billing_email = 'mine@contact.example' where id = $1", [contactId]));
    expect((await source(token)).billing).toEqual({ address: "רחוב הרצל 5, חיפה", email: "mine@contact.example", tax_id: "000000018" });
    // a contact in the bin prints none, as the staff read does
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [contactId]));
    try {
      expect((await source(token)).billing).toEqual({ address: null, email: null, tax_id: null });
    } finally {
      await asAdmin((q) => q("update public.contacts set deleted_at = null where id = $1", [contactId]));
    }

    // a deal quote whose deal has a company and no contact: the company's own details
    const onCompany = await asUser(member.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id, company_id) values ($1, 'עסקה לחברה', $2, $3, $4, $5) returning id", [
          org,
          pipe.pipelineId,
          pipe.stageId,
          member.id,
          companyId,
        ])
      ).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה לחברה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const companyToken = await link(member, onCompany);
    expect((await accept(companyToken)).status).toBe("accepted");
    expect((await source(companyToken)).billing).toEqual({ address: "כתובת החברה", email: "billing@acme.example", tax_id: "000000026" });
    // review: a company quote whose company is in the bin prints none
    await asAdmin((q) => q("update public.companies set deleted_at = now() where id = $1", [companyId]));
    try {
      expect((await source(companyToken)).billing).toEqual({ address: null, email: null, tax_id: null });
    } finally {
      await asAdmin((q) => q("update public.companies set deleted_at = null where id = $1", [companyId]));
    }

    // owner (37) ב: a member who reads the record gets the acceptance time through getQuoteAcceptedAt's query (the record's
    // column, `@>` on metadata, the user's session); someone who does not read it gets nothing
    const acceptedAt = (u: U, column: "deal_id" | "contact_id", quoteId: string) =>
      asUser(u.id, async (q) =>
        (
          await q<{ created_at: Date }>(
            `select created_at from public.activities
              where organization_id = $1 and ${column} = (select ${column} from public.quotes where id = $2)
                and type = 'system' and metadata @> jsonb_build_object('kind', 'quote_accepted', 'quote_id', $2::uuid)
              order by created_at desc limit 1`,
            [org, quoteId],
          )
        ).rows[0]?.created_at ?? null,
      );
    for (const [column, quoteId] of [
      ["contact_id", onContact],
      ["deal_id", onCompany],
    ] as const) {
      const decided = (await asAdmin((q) => one<{ d: Date }>(q, "select decided_at as d from public.quote_decisions where quote_id = $1", [quoteId]))).d;
      const seen = await acceptedAt(member, column, quoteId);
      expect(seen, column).not.toBeNull();
      expect(Math.abs(seen!.getTime() - decided.getTime()), column).toBeLessThan(5000);
      // the member does not read quote_decisions
      expect(await asUser(member.id, (q) => count(q, "select 1 from public.quote_decisions where quote_id = $1", [quoteId])), column).toBe(0);
      // another member under own visibility reads neither the record nor the entry
      expect(await acceptedAt(other, column, quoteId), column).toBeNull();
    }
    // the helper is internal: no API role runs it
    const can = async (role: string) =>
      (await asAdmin((q) => one<{ c: boolean }>(q, "select has_function_privilege($1, 'app.quote_customer_billing(public.quotes)', 'execute') as c", [role]))).c;
    for (const role of ["anon", "authenticated", "service_role"]) expect(await can(role), role).toBe(false);
  });

  it("a quote with no PDF as sent gets the signed one as its first file", async () => {
    const quoteId = await newQuote(member);
    const token = await link(member, quoteId);
    expect((await accept(token)).status).toBe("accepted");
    const fp = await decisionFingerprint(quoteId);
    const signed = await signFully(token, sha("1"), fp);
    expect(await files(quoteId)).toEqual([{ id: signed.id, previous_id: null, quote_signed: true, sha256: sha("1") }]);
    expect(await download(token)).toMatchObject({ sha256: sha("1") });
    // and no PDF as sent is made after it
    expect(
      (await pgError(asService((q) => q("select public.quote_pdf_store($1, $2, $3, 20000, $4, 'הצעה.pdf')", [org, quoteId, member.id, sha("2")])))).hint,
    ).toBe("quote_pdf:closed");
  });

  it("the rules hold for every writer: a signed row only on an accepted quote, after the PDF as sent; a PDF as sent is never a version; one signed each", async () => {
    const open = await newQuote(member);
    const sentOpen = await storeSent(member, open);
    const insert = (quoteId: string, signed: boolean | null, previous: string | null) =>
      asAdmin((q) =>
        q(
          "insert into public.files (organization_id, quote_id, quote_signed, previous_id, name, mime_type, size_bytes, sha256) values ($1, $2, $3, $4, 'x.pdf', 'application/pdf', 1, $5)",
          [org, quoteId, signed, previous, sha("9")],
        ),
      );
    expect((await pgError(insert(open, true, sentOpen.id))).hint).toBe("quote_pdf:not_accepted");
    expect((await pgError(insert(open, null, sentOpen.id))).hint).toBe("quote_pdf:version");
    expect((await pgError(insert(open, false, null))).code).toBe("23514");
    const accepted = await newQuote(member);
    const sent = await storeSent(member, accepted);
    expect((await accept(await link(member, accepted))).status).toBe("accepted");
    // it follows the PDF as sent, nothing else
    expect((await pgError(insert(accepted, true, null))).code).toMatch(/^(P0001|23505)$/);
    expect((await pgError(insert(accepted, true, sentOpen.id))).hint).toBe("quote_pdf:version");
    await insert(accepted, true, sent.id);
    expect((await pgError(insert(accepted, true, sent.id))).code).toMatch(/^(P0001|23505)$/);
    // a person never writes one
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.files (organization_id, quote_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1)", [org, accepted]))))
        .code,
    ).toBe("42501");
  });

  it("staff: owners and admins only (review, high): the block and the write; checked again for that user; the acceptance stays", async () => {
    const quoteId = await newQuote(member);
    const sent = await storeSent(member, quoteId);
    const token = await link(member, quoteId);
    expect(await staffAllowed(admin, quoteId)).toBeNull();
    expect((await accept(token)).status).toBe("accepted");
    // owners and admins get the block to render
    const block = await staffAllowed(admin, quoteId);
    expect(block).toMatchObject({ signer_name: "נועה לוי", kind: "drawn" });
    expect(await staffAllowed(owner, quoteId)).not.toBeNull();
    // anyone else is refused, the member who owns the quote and a manager included, under org visibility too
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    try {
      for (const u of [member, manager, viewer, other, outsider]) expect((await pgError(staffAllowed(u, quoteId))).code, u.email).toBe("42501");
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    }
    // an owner of another business is answered nothing about this business's quote
    expect(await staffAllowed(outsider, quoteId, outsiderOrg)).toBeNull();
    // the write checks the named user again: an active owner or admin only
    for (const u of [member, manager, viewer, other, outsider]) {
      expect((await pgError(staffStore(u, quoteId, sha("5"), null, block!.fingerprint))).code, u.email).toBe("42501");
    }
    expect((await pgError(staffStore(admin, quoteId, sha("5"), null, block!.fingerprint, outsiderOrg))).code).toBe("42501");

    // owner (337) א: a quote's PDF is never refused by max_pdf_per_month (the full-month refusal is gone); the quote stays accepted
    expect(await asAdmin((q) => one<{ status: string }>(q, "select status from public.quotes where id = $1", [quoteId]))).toEqual({ status: "accepted" });
    expect(await download(token)).toMatchObject({ sha256: sha("a") });

    // then an admin makes it
    const first = await staffStore(admin, quoteId, sha("6"), null, block!.fingerprint);
    expect(first.status).toBe("upload");
    // while it waits the customer still gets the PDF as sent
    expect(await download(token)).toMatchObject({ path: sent.path });
    await putObject(first.path!);
    const second = await staffStore(admin, quoteId, sha("6"), first.path!, block!.fingerprint);
    expect(second.status).toBe("stored");
    expect(await download(token)).toMatchObject({ sha256: sha("6") });
    expect(await staffAllowed(admin, quoteId)).toBeNull();
  });

  it("busy and takeover on the signed row: another render waits two minutes, then takes it over to a fresh path", async () => {
    const quoteId = await newQuote(member);
    const token = await link(member, quoteId);
    expect((await accept(token)).status).toBe("accepted");
    const fp = await decisionFingerprint(quoteId);
    const first = await publicStore(token, sha("1"), null, fp);
    expect(first.status).toBe("upload");
    expect(await publicStore(token, sha("2"), null, fp)).toEqual({ status: "busy" });
    await asAdmin((q) => q("update public.files set upload_checked_at = now() - interval '3 minutes' where quote_id = $1 and quote_signed", [quoteId]));
    const taken = await publicStore(token, sha("2"), null, fp);
    expect(taken.status).toBe("upload");
    expect(taken.path).not.toBe(first.path);
    // the first attempt's path goes to the orphan cleanup; its late second call confirms nothing
    expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [first.path]))).toBe(1);
    await putObject(first.path!);
    expect((await publicStore(token, sha("1"), first.path!, fp)).status).toBe("busy");
    await putObject(taken.path!);
    const stored = await publicStore(token, sha("2"), taken.path!, fp);
    expect(stored.status).toBe("stored");
    expect(await files(quoteId)).toEqual([{ id: stored.file_id, previous_id: null, quote_signed: true, sha256: sha("2") }]);
  });

  it("refused: an erased decision, a revoked link, a deleted customer, the plan without quotes", async () => {
    // an erased decision: nothing to sign for anyone
    const erased = await newQuote(member);
    const erasedToken = await link(member, erased);
    expect((await accept(erasedToken)).status).toBe("accepted");
    const fp = await decisionFingerprint(erased);
    await asAdmin((q) => q("update public.quote_decisions set erased_at = now() where quote_id = $1", [erased]));
    expect(await source(erasedToken)).toEqual({ unavailable: true });
    expect((await pgError(publicStore(erasedToken, sha("3"), null, fp))).hint).toBe("quote_pdf:not_accepted");
    expect(await staffAllowed(admin, erased)).toBeNull();
    expect((await pgError(staffStore(admin, erased, sha("3"), null, fp))).hint).toBe("quote_pdf:not_accepted");

    // a revoked link: not found
    const revoked = await newQuote(member);
    const revokedToken = await link(member, revoked);
    expect((await accept(revokedToken)).status).toBe("accepted");
    await asUser(member.id, (q) => q("select public.quote_link_revoke($1, $2)", [org, revoked]));
    expect((await pgError(source(revokedToken))).code).toBe("P0002");
    expect((await pgError(publicStore(revokedToken, sha("3"), null, await decisionFingerprint(revoked)))).code).toBe("P0002");

    // a deleted customer: the quote is detached; not found by the link, not accepted for staff
    const { contactId, quoteId } = await asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [org, member.id])).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה לדנה', $2) returning id", [org, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return { contactId: contact, quoteId: id };
    });
    const deletedToken = await link(member, quoteId);
    expect((await accept(deletedToken)).status).toBe("accepted");
    const deletedFp = await decisionFingerprint(quoteId);
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contactId]);
      await q("delete from public.contacts where id = $1", [contactId]);
    });
    expect((await pgError(publicStore(deletedToken, sha("4"), null, deletedFp))).code).toBe("P0002");
    // the detached quote has no deal or contact left, so app.quote_pdf_user_may refuses the named user
    expect((await pgError(staffStore(owner, quoteId, sha("4"), null, deletedFp))).code).toBe("42501");

    // the plan without quotes: the link answers not found; staff are refused by the flag
    const flagged = await newQuote(member);
    const flaggedToken = await link(member, flagged);
    expect((await accept(flaggedToken)).status).toBe("accepted");
    const flaggedFp = await decisionFingerprint(flagged);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}'::jsonb where organization_id = $1", [org]));
    try {
      expect((await pgError(publicStore(flaggedToken, sha("5"), null, flaggedFp))).code).toBe("P0002");
      expect(await staffAllowed(admin, flagged)).toBeNull();
      expect((await pgError(staffStore(admin, flagged, sha("5"), null, flaggedFp))).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'quotes' where organization_id = $1", [org]));
    }
    expect(await files(flagged)).toEqual([]);
  });

  it("the quiet read hides only the quote it names: another quote's view still counts", async () => {
    const quoteId = await newQuote(member);
    const token = await link(member, quoteId);
    const before = await views(quoteId);
    await asService(async (q) => {
      await q("select set_config('app.quote_view_quiet', $1, true)", ["00000000-0000-0000-0000-000000000000"]);
      await q("select public.quote_public($1)", [token]);
    });
    expect(await views(quoteId)).toBe(before + 1);
    await asService(async (q) => {
      await q("select set_config('app.quote_view_quiet', $1, true)", [quoteId]);
      await q("select public.quote_public($1)", [token]);
    });
    expect(await views(quoteId)).toBe(before + 1);
  });

  it("a declined quote has nothing to sign", async () => {
    const quoteId = await newQuote(member);
    const token = await link(member, quoteId);
    const fp = (await version(token)).fingerprint!;
    await asService((q) => q("select public.quote_public_answer(p_token => $1, p_decision => 'rejected', p_fingerprint => $2)", [token, fp]));
    expect(await staffAllowed(owner, quoteId)).toBeNull();
    expect((await pgError(staffStore(owner, quoteId, sha("7"), null, fp))).hint).toBe("quote_pdf:not_accepted");
  });

  it("a re-run of 020955 (which makes files_quote_pdf_one) also re-runs the pasted file that removes it", () => {
    expect(rerunClosure([migrationFile("_quote_pdfs.sql")]).files).toContain(migrationFile("_quote_signed_pdf_index.sql"));
  });

  it("a privacy erasure of the quote's contact removes every version, the signed one included", async () => {
    const { contactId, quoteId } = await asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה לוי', $2) returning id", [org, member.id])).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה לנועה', $2) returning id", [org, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return { contactId: contact, quoteId: id };
    });
    const sent = await storeSent(member, quoteId);
    const token = await link(member, quoteId);
    expect((await accept(token)).status).toBe("accepted");
    const signed = await signFully(token, sha("8"), await decisionFingerprint(quoteId));
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contactId]);
      await q("delete from public.contacts where id = $1", [contactId]);
    });
    expect(await asAdmin((q) => count(q, "select 1 from public.files where quote_id = $1", [quoteId]))).toBe(2);
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contactId]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where quote_id = $1", [quoteId]))).toBe(0);
    for (const path of [sent.path, signed.path]) {
      expect(await asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [path])), path).toBe(1);
    }
  });
});

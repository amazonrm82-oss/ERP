import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * QUO-06: the PDF of every sent quote version is kept once, as a file of the quote in record-files: whoever may edit the
 * quote's deal or contact stores it, whoever reads the quote reads it, nobody deletes it; and every new PDF counts against
 * the business's max_pdf_per_month (owner, 13 October 2026), at most 30 a minute, with one notice at 80%.
 */
describe("quote PDFs and the monthly PDF quota (QUO-06)", () => {
  let owner: U, admin: U, member: U, other: U, viewer: U, outsider: U;
  let org: string, outsiderOrg: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const quote = (u: U, send = true) =>
    asUser(u.id, async (q) => {
      const deal = (
        await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
          org,
          pipelineId,
          stageId,
          u.id,
        ])
      ).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id) values ($1, 'הצעה', $2) returning id", [org, deal])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      if (send) await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
  const store = (u: U, quoteId: string, type = "application/pdf", orgId = org) =>
    asUser(u.id, (q) =>
      one<{ id: string; storage_path: string; unconfirmed_since: Date | null }>(
        q,
        "insert into public.files (organization_id, quote_id, name, mime_type, size_bytes) values ($1, $2, 'הצעת מחיר.pdf', $3, 20000) returning id, storage_path, unconfirmed_since",
        [orgId, quoteId, type],
      ),
    );
  // what the Storage API and confirm_file_upload do after an upload: the object with its measured type, then the check
  const upload = async (u: U, file: { id: string; storage_path: string }, type = "application/pdf") => {
    await asUser(u.id, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [file.storage_path]));
    await asAdmin((q) =>
      q("update storage.objects set metadata = jsonb_build_object('size', 20000::bigint, 'mimetype', $2::text) where bucket_id = 'record-files' and name = $1", [
        file.storage_path,
        type,
      ]),
    );
    return asUser(u.id, async (q) => (await one<{ r: { ok: boolean; reason?: string } }>(q, "select public.confirm_file_upload($1, $2) as r", [org, file.id])).r);
  };
  const remove = (u: U, fileId: string) => asUser(u.id, async (q) => (await q("delete from public.files where id = $1", [fileId])).rowCount);
  const orphaned = (path: string) => asAdmin((q) => count(q, "select 1 from app.orphan_files where storage_path = $1", [path]));
  const sees = (u: U, fileId: string) => asUser(u.id, (q) => count(q, "select 1 from public.files where id = $1", [fileId]));
  const produced = () =>
    asAdmin(async (q) => (await q<{ produced: number }>("select produced from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [org])).rows[0]?.produced ?? 0);
  const setLimit = (limit: number | null) =>
    asAdmin((q) =>
      q("update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || jsonb_build_object('max_pdf_per_month', $2::numeric) where organization_id = $1", [
        org,
        limit,
      ]),
    );
  const resetCount = () => asAdmin((q) => q("update app.pdf_months set produced = 0, minute_count = 0, minute_start = null, warned_80_at = null where organization_id = $1", [org]));

  beforeAll(async () => {
    owner = await createUser("qpdf-owner");
    org = await createOrg(owner.id, "עסק ההצעות");
    admin = await addMember(org, owner.id, "admin", "qpdf-admin");
    member = await addMember(org, owner.id, "member", "qpdf-member");
    other = await addMember(org, owner.id, "member", "qpdf-other");
    viewer = await addMember(org, owner.id, "viewer", "qpdf-viewer");
    outsider = await createUser("qpdf-outsider");
    outsiderOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    await asUser(owner.id, (q) =>
      q("insert into public.org_document_settings (organization_id, vat_status) values ($1, 'licensed') on conflict (organization_id) do update set vat_status = 'licensed'", [org]),
    );
    await setLimit(1000);
  });

  it("whoever may edit a sent quote stores its PDF; whoever reads the quote reads it; others do not", async () => {
    const id = await quote(member);
    const file = await store(member, id);
    expect(file.storage_path).toBe(`${org}/${file.id}`);
    // a person's row waits for its upload, like every file
    expect(file.unconfirmed_since).not.toBeNull();
    for (const u of [owner, admin, member]) expect(await sees(u, file.id), u.email).toBe(1);
    expect(await sees(outsider, file.id)).toBe(0);
    // a viewer reads what it reads of the quote, never more
    const viewerReadsQuote = await asUser(viewer.id, (q) => count(q, "select 1 from public.quotes where id = $1", [id]));
    expect(await sees(viewer, file.id)).toBe(viewerReadsQuote);
  });

  it("a viewer, another member who may not edit the deal and an outsider cannot store one", async () => {
    const id = await quote(owner);
    expect((await pgError(store(viewer, id))).code).toBe("42501");
    expect((await pgError(store(outsider, id))).code).toBe("42501");
    // the outsider's own business, pointing at this business's quote
    expect(["42501", "23503"]).toContain((await pgError(store(outsider, id, "application/pdf", outsiderOrg))).code);
    // a member edits only the deals they own
    expect((await pgError(store(other, id))).code).toBe("42501");
  });

  it("a draft has no PDF; a quote has one PDF; it is a PDF", async () => {
    const draft = await quote(owner, false);
    expect((await pgError(store(owner, draft))).code).toBe("42501");
    expect((await pgError(asAdmin((q) => q("insert into public.files (organization_id, quote_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1)", [org, draft])))).hint).toBe(
      "quote_pdf:draft",
    );
    const sent = await quote(owner);
    expect((await pgError(store(owner, sent, "image/png"))).code).toBe("23514");
    await store(owner, sent);
    expect((await pgError(store(owner, sent))).code).toBe("23505");
    // never on a note, never a version of another file
    const third = await quote(owner);
    const first = await store(owner, third);
    const version = await pgError(
      asUser(owner.id, (q) =>
        q("insert into public.files (organization_id, quote_id, name, mime_type, size_bytes, previous_id) values ($1, $2, 'x.pdf', 'application/pdf', 1, $3)", [org, third, first.id]),
      ),
    );
    expect(["23514", "23505", "P0001"]).toContain(version.code);
  });

  it("is kept: nobody deletes a confirmed quote PDF; the uploader removes an upload that never arrived", async () => {
    const id = await quote(owner);
    const waiting = await store(owner, id);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.files where id = $1", [waiting.id])).rowCount)).toBe(1);
    const file = await store(owner, id);
    await asAdmin((q) => q("update public.files set unconfirmed_since = null where id = $1", [file.id]));
    for (const u of [owner, admin]) expect(await asUser(u.id, async (q) => (await q("delete from public.files where id = $1", [file.id])).rowCount), u.email).toBe(0);
    expect((await pgError(asAdmin((q) => q("delete from public.files where id = $1", [file.id])))).hint).toBe("file:kept");
    expect(await sees(owner, file.id)).toBe(1);
  });

  it("needs the quotes flag", async () => {
    const id = await quote(owner);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{\"quotes\": false}'::jsonb where organization_id = $1", [org]));
    try {
      expect((await pgError(store(owner, id))).hint).toBe("feature:quotes");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides - 'quotes' where organization_id = $1", [org]));
    }
  });

  it("counts every new PDF against max_pdf_per_month; a full quota refuses only new PDFs; one notice at 80%", async () => {
    await resetCount();
    await setLimit(3);
    const notices = () =>
      asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and type = 'system' and title like 'קובצי ה-PDF הגיעו ל-80%%'", [org]));
    const before = await notices();
    const quotes = [await quote(owner), await quote(owner), await quote(owner), await quote(owner)];
    await store(owner, quotes[0]);
    await store(owner, quotes[1]);
    expect(await produced()).toBe(2);
    expect(await notices()).toBe(before);
    await store(owner, quotes[2]);
    expect(await produced()).toBe(3);
    // ceil(3 x 0.8) = 3: the active owner and admin, once
    expect(await notices()).toBe(before + 2);
    const full = await pgError(store(owner, quotes[3]));
    expect(full.hint).toBe("limit:max_pdf_per_month");
    // a refused PDF is not counted, and the quote itself still works (its link)
    expect(await produced()).toBe(3);
    const token = await asUser(owner.id, async (q) => (await one<{ t: string }>(q, "select public.quote_link_create($1, $2) as t", [org, quotes[3]])).t);
    expect(token).toMatch(/.+/);
    await setLimit(4);
    await store(owner, quotes[3]);
    expect(await notices()).toBe(before + 2);
    await setLimit(1000);
  });

  it("at most 30 new PDFs a minute per business", async () => {
    await resetCount();
    const id = await quote(owner);
    await asAdmin((q) => q("update app.pdf_months set minute_start = now(), minute_count = 30 where organization_id = $1 and month = app.automation_run_month($1)", [org]));
    expect((await pgError(store(owner, id))).hint).toBe("rate:pdf");
    await asAdmin((q) => q("update app.pdf_months set minute_start = now() - interval '2 minutes' where organization_id = $1", [org]));
    await store(owner, id);
    const row = await asAdmin((q) => one<{ minute_count: number }>(q, "select minute_count from app.pdf_months where organization_id = $1 and month = app.automation_run_month($1)", [org]));
    expect(row.minute_count).toBe(1);
  });

  it("the counter has no client access", async () => {
    for (const u of [owner, outsider]) expect((await pgError(asUser(u.id, (q) => q("select * from app.pdf_months")))).code, u.email).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.pdf_take($1)", [org])))).code).toBe("42501");
  });

  it("is made later only while the quote is sent or viewed (review L3)", async () => {
    const id = await quote(owner);
    await asUser(owner.id, (q) => q("select public.quote_cancel($1, $2)", [org, id]));
    expect((await pgError(store(owner, id))).code).toBe("42501");
    expect(
      (await pgError(asAdmin((q) => q("insert into public.files (organization_id, quote_id, name, mime_type, size_bytes) values ($1, $2, 'x.pdf', 'application/pdf', 1)", [org, id])))).hint,
    ).toBe("quote_pdf:closed");
    const viewed = await quote(owner);
    await asAdmin((q) => q("update public.quotes set status = 'viewed' where id = $1", [viewed]));
    await store(owner, viewed);
  });

  it("a non-PDF object is answered, not raised; the real PDF confirms (review L2)", async () => {
    const id = await quote(owner);
    const file = await store(owner, id);
    expect(await upload(owner, file, "image/png")).toEqual({ ok: false, reason: "type" });
    const row = await asAdmin((q) => one<{ unconfirmed_since: Date | null; mime_type: string }>(q, "select unconfirmed_since, mime_type from public.files where id = $1", [file.id]));
    expect(row.unconfirmed_since).not.toBeNull();
    expect(row.mime_type).toBe("application/pdf");
    const other = await quote(owner);
    expect(await upload(owner, await store(owner, other))).toEqual({ ok: true });
  });

  it("an owner or admin removes someone else's upload that never arrived, never a confirmed PDF; a member cannot (review L1)", async () => {
    const id = await quote(member);
    const waiting = await store(member, id);
    expect(await remove(other, waiting.id)).toBe(0);
    expect(await remove(admin, waiting.id)).toBe(1);
    const again = await store(member, id);
    await asAdmin((q) => q("update public.files set unconfirmed_since = null where id = $1", [again.id]));
    for (const u of [owner, admin, member]) expect(await remove(u, again.id), u.email).toBe(0);
  });

  it("removing a waiting PDF gives its count back, so retries never drain the month (review M2)", async () => {
    await resetCount();
    await setLimit(2);
    try {
      const id = await quote(owner);
      for (let i = 0; i < 5; i++) {
        const waiting = await store(owner, id);
        expect(await produced()).toBe(1);
        expect(await remove(owner, waiting.id)).toBe(1);
        expect(await produced()).toBe(0);
      }
      const kept = await store(owner, id);
      await upload(owner, kept);
      expect(await produced()).toBe(1);
    } finally {
      await setLimit(1000);
    }
  });

  it("a privacy erasure of the quote's contact removes its PDF; the object goes to the orphan cleanup (review H1)", async () => {
    const { contactId, quoteId } = await asUser(member.id, async (q) => {
      const contact = (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'נועה לוי', $2) returning id", [org, member.id])).id;
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, contact_id) values ($1, 'הצעה לנועה', $2) returning id", [org, contact])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return { contactId: contact, quoteId: id };
    });
    const file = await store(member, quoteId);
    expect(await upload(member, file)).toEqual({ ok: true });
    // the purge alone keeps it (the quote is detached and still the business's)
    await asUser(owner.id, async (q) => {
      await q("update public.contacts set deleted_at = now() where id = $1", [contactId]);
      await q("delete from public.contacts where id = $1", [contactId]);
    });
    expect(await sees(owner, file.id)).toBe(1);
    // nobody deletes it by hand, a session setting does not open it either
    expect(await remove(owner, file.id)).toBe(0);
    expect(
      (
        await pgError(
          asAdmin(async (q) => {
            await q("select set_config('app.quote_pdf_erase', $1, true)", ["00000000-0000-0000-0000-000000000000"]);
            await q("delete from public.files where id = $1", [file.id]);
          }),
        )
      ).hint,
    ).toBe("file:kept");
    await asUser(owner.id, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contactId]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    expect(await orphaned(file.storage_path)).toBe(1);
    // the quote itself stays, emptied of the person
    expect(await asAdmin((q) => one<{ title: string }>(q, "select title from public.quotes where id = $1", [quoteId]))).toEqual({ title: "הצעת מחיר" });
  });

  it("removing a person (lead converted to a contact with a quote on the deal) removes the quote's PDF too (review H1)", async () => {
    const lead = await insertLead(member.id, org, { full_name: "אורי ברק", owner_id: member.id, phone: "050-7771234" });
    const converted = await asUser(member.id, async (q) =>
      (await one<{ r: { contact_id: string; deal_id: string } }>(q, "select public.convert_lead($1, true, null, 100000) as r", [lead])).r,
    );
    await asAdmin((q) => q("update public.deals set name = 'עבודת שיפוץ' where id = $1", [converted.deal_id]));
    const quoteId = await asUser(member.id, async (q) => {
      const id = (await one<{ id: string }>(q, "insert into public.quotes (organization_id, title, deal_id, contact_id) values ($1, 'הצעה', $2, $3) returning id", [
        org,
        converted.deal_id,
        converted.contact_id,
      ])).id;
      await q("insert into public.quote_lines (organization_id, quote_id, name, quantity, unit_price_agorot) values ($1, $2, 'עבודה', 1, 10000)", [org, id]);
      await q("select public.quote_send($1, $2)", [org, id]);
      return id;
    });
    const file = await store(member, quoteId);
    expect(await upload(member, file)).toEqual({ ok: true });
    await asMfaUser(admin.id, (q) => q("select public.privacy_erase_person($1, 'leads', $2, '[]'::jsonb, 'הלקוח ביקש', '{}'::jsonb, true)", [org, lead]));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [file.id]))).toBe(0);
    expect(await orphaned(file.storage_path)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.quotes where id = $1", [quoteId]))).toBe(1);
  });
});

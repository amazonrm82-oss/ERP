import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, insertLead, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type F = { id: string; storage_path: string; previous_id: string | null; lead_id: string | null; contact_id: string | null; deal_id: string | null };

/**
 * DOC-01 follow-up (lane ד): a recorded accounting document takes a file (a PDF or an image of what was issued) through
 * the shared files mechanism. Reading follows the document; adding needs the documents rules; one current file per
 * document, earlier ones kept as versions linked by the server; Storage follows public.files as before.
 */
describe("files on accounting documents", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const newContact = (u: U, orgId = org) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'דנה', $2) returning id", [orgId, u.id])).id);
  const newDeal = (u: U) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
            org,
            pipelineId,
            stageId,
            u.id,
          ])
        ).id,
    );
  const record = (u: U, parent: { deal?: string; contact?: string }, orgId = org) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, 'tax_invoice', $4, 1000) returning id",
            [orgId, parent.deal ?? null, parent.contact ?? null, `F-${++n}`],
          )
        ).id,
    );
  const attach = (u: U, documentId: string, opts: { type?: string; previous?: string | null; orgId?: string } = {}) =>
    run(
      u,
      async (q) =>
        await one<F>(
          q,
          `insert into public.files (organization_id, accounting_document_id, name, mime_type, size_bytes, previous_id)
           values ($1, $2, 'חשבונית.pdf', $3, 1000, $4) returning id, storage_path, previous_id, lead_id, contact_id, deal_id`,
          [opts.orgId ?? org, documentId, opts.type ?? "application/pdf", opts.previous ?? null],
        ),
    );
  const visible = (u: U, fileId: string) => run(u, (q) => count(q, "select 1 from public.files where id = $1", [fileId]));
  const exists = (fileId: string) => asAdmin((q) => count(q, "select 1 from public.files where id = $1", [fileId]));
  const remove = (u: U, fileId: string) => run(u, async (q) => (await q("delete from public.files where id = $1", [fileId])).rowCount);
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  // what the Storage API does: the object row as the user, then the metadata it measured
  const putObject = async (u: U, path: string, size: number, mimetype: string) => {
    await run(u, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [path]));
    await asAdmin((q) =>
      q("update storage.objects set metadata = jsonb_build_object('size', $2::bigint, 'mimetype', $3::text) where bucket_id = 'record-files' and name = $1", [path, size, mimetype]),
    );
  };
  const confirm = (u: U, fileId: string) =>
    run(u, async (q) => (await one<{ r: { ok: boolean; reason?: string } }>(q, "select public.confirm_file_upload($1, $2) as r", [org, fileId])).r);

  beforeAll(async () => {
    owner = await createUser("dfile-owner");
    org = await createOrg(owner.id, "עסק הקבצים");
    admin = await addMember(org, owner.id, "admin", "dfile-admin");
    manager = await addMember(org, owner.id, "manager", "dfile-manager");
    member = await addMember(org, owner.id, "member", "dfile-member");
    keyHolder = await addMember(org, owner.id, "member", "dfile-key");
    viewer = await addMember(org, owner.id, "viewer", "dfile-viewer");
    outsider = await createUser("dfile-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    await setFeatures({ documents: true, granular_permissions: true });
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents}')", [org, keyHolder.id]));
  });

  it("whoever records documents attaches a file; a member without the key, a viewer and an outsider cannot", async () => {
    const contact = await newContact(owner);
    for (const u of [owner, admin, manager, keyHolder]) {
      const doc = await record(owner, { contact });
      const file = await attach(u, doc);
      // the document is the file's one subject: no record columns
      expect([file.lead_id, file.contact_id, file.deal_id], u.email).toEqual([null, null, null]);
      expect(file.storage_path, u.email).toBe(`${org}/${file.id}`);
    }
    const doc = await record(owner, { contact });
    for (const u of [member, viewer, outsider]) expect((await pgError(attach(u, doc))).code, u.email).toBe("42501");
    // a member reads the document, and still sees no way in
    expect(await run(member, (q) => count(q, "select 1 from public.accounting_documents where id = $1", [doc]))).toBe(1);
  });

  it("needs the plan's documents key (a hint for a recorder; RLS's plain refusal for anyone else)", async () => {
    const doc = await record(owner, { contact: await newContact(owner) });
    await setFeatures({ documents: false, granular_permissions: true });
    try {
      expect((await pgError(attach(owner, doc))).hint).toBe("feature:documents");
      expect((await pgError(attach(member, doc))).code).toBe("42501");
    } finally {
      await setFeatures({ documents: true, granular_permissions: true });
    }
    // the personal key works only while the plan has granular permissions (PRM-01)
    await setFeatures({ documents: true, granular_permissions: false });
    try {
      expect((await pgError(attach(keyHolder, doc))).code).toBe("42501");
    } finally {
      await setFeatures({ documents: true, granular_permissions: true });
    }
  });

  it("takes a PDF or an image only: as declared, and as Storage really holds it", async () => {
    const doc = await record(owner, { contact: await newContact(owner) });
    for (const type of ["application/zip", "text/plain", "application/msword", "image/svg+xml"]) {
      expect((await pgError(attach(owner, doc, { type }))).hint, type).toBe("file:document_type");
    }
    // declared a PDF, really a ZIP: refused on confirmation and left waiting (hidden)
    const wrong = await attach(owner, doc);
    await putObject(owner, wrong.storage_path, 1000, "application/zip");
    expect(await confirm(owner, wrong.id)).toEqual({ ok: false, reason: "type" });
    // the reconciler holds the same rule
    await asAdmin((q) => q("update public.files set unconfirmed_since = now() - interval '20 minutes', upload_checked_at = null where id = $1", [wrong.id]));
    await asAdmin((q) => q("select app.reconcile_pending_files(5000)"));
    expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1 and unconfirmed_since is not null", [wrong.id]))).toBe(1);
    // an image is fine; the same ZIP on a record's file still is too (the record rules are unchanged)
    const image = await attach(owner, doc, { type: "image/png", previous: wrong.id });
    await putObject(owner, image.storage_path, 2000, "image/png");
    expect(await confirm(owner, image.id)).toEqual({ ok: true });
    const lead = await insertLead(owner.id, org);
    const recordFile = await run(owner, (q) =>
      one<{ id: string; storage_path: string }>(q, "insert into public.files (organization_id, lead_id, name, mime_type, size_bytes) values ($1, $2, 'a.zip', 'application/zip', 10) returning id, storage_path", [
        org,
        lead,
      ]),
    );
    await putObject(owner, recordFile.storage_path, 10, "application/zip");
    expect(await confirm(owner, recordFile.id)).toEqual({ ok: true });
  });

  it("is read by whoever reads the document: its deal, else its contact", async () => {
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const ownersDeal = await newDeal(owner);
      const doc = await record(owner, { deal: ownersDeal });
      const file = await attach(owner, doc);
      for (const u of [owner, admin]) expect(await visible(u, file.id), u.email).toBe(1);
      // a member who does not read the owner's deal sees neither the document nor its file, and the key changes nothing
      for (const u of [member, keyHolder, outsider]) expect(await visible(u, file.id), u.email).toBe(0);
      expect((await pgError(attach(keyHolder, doc))).code).toBe("42501");
      // the member's own contact: the member reads it, and the key holder records on their own
      const keyContact = await newContact(keyHolder);
      const keyDoc = await record(keyHolder, { contact: keyContact });
      const keyFile = await attach(keyHolder, keyDoc);
      expect(await visible(keyHolder, keyFile.id)).toBe(1);
      expect(await visible(member, keyFile.id)).toBe(0);
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("keeps one current file: the server links a new one to the latest, and a stale earlier one is refused", async () => {
    const doc = await record(owner, { contact: await newContact(owner) });
    const first = await attach(owner, doc);
    expect(first.previous_id).toBeNull();
    // a second file without naming the first still becomes its newer version
    const second = await attach(manager, doc);
    expect(second.previous_id).toBe(first.id);
    // naming a version that is no longer the latest is refused; naming the latest is fine
    expect((await pgError(attach(admin, doc, { previous: first.id }))).hint).toBe("file:version_taken");
    const third = await attach(admin, doc, { previous: second.id });
    expect(third.previous_id).toBe(second.id);
    // a file of another document is not an earlier version of this one
    const otherDoc = await record(owner, { contact: await newContact(owner) });
    expect((await pgError(attach(owner, otherDoc, { previous: third.id }))).hint).toBe("file:version_taken");
    // removing the middle one keeps the history one line
    expect(await remove(manager, second.id)).toBe(1);
    expect(await asAdmin(async (q) => (await one<{ previous_id: string }>(q, "select previous_id from public.files where id = $1", [third.id])).previous_id)).toBe(first.id);
    expect(await asAdmin((q) => count(q, "select 1 from public.files where accounting_document_id = $1 and previous_id is null", [doc]))).toBe(1);
  });

  it("is removed by its uploader or an admin who may record documents, never by anyone else", async () => {
    const doc = await record(owner, { contact: await newContact(owner) });
    const byManager = await attach(manager, doc);
    const byKey = await attach(keyHolder, doc);
    // a recorder who did not upload it, a member, a viewer and an outsider remove nothing
    for (const u of [keyHolder, member, viewer, outsider]) expect(await remove(u, byManager.id), u.email).toBe(0);
    expect(await exists(byManager.id)).toBe(1);
    expect(await remove(keyHolder, byKey.id)).toBe(1);
    expect(await remove(admin, byManager.id)).toBe(1);
    // a DELETE with no WHERE from another business reaches nothing
    const kept = await attach(owner, doc);
    await run(outsider, (q) => q("delete from public.files"));
    expect(await exists(kept.id)).toBe(1);
  });

  it("a cancelled document still takes a file (the paper that was issued); the document's facts stay frozen", async () => {
    const doc = await record(owner, { contact: await newContact(owner) });
    await run(owner, (q) => q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'הופקה בטעות' where id = $1", [doc]));
    const file = await attach(manager, doc);
    expect(await visible(manager, file.id)).toBe(1);
    expect(await asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.accounting_documents where id = $1", [doc])).status)).toBe("cancelled");
  });

  it("one subject only: never also on a record or a timeline entry, never on another business's document", async () => {
    const contact = await newContact(owner);
    const doc = await record(owner, { contact });
    expect(
      (await pgError(
        run(owner, (q) =>
          q("insert into public.files (organization_id, contact_id, accounting_document_id, name, mime_type, size_bytes) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)", [
            org,
            contact,
            doc,
          ]),
        ),
      )).code,
    ).toBe("23514");
    const note = await run(owner, async (q) =>
      (await one<{ id: string }>(q, "insert into public.activities (organization_id, contact_id, type, body) values ($1, $2, 'note', 'הערה') returning id", [org, contact])).id,
    );
    const onNote = await pgError(
      run(owner, (q) =>
        q("insert into public.files (organization_id, activity_id, accounting_document_id, name, mime_type, size_bytes) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)", [org, note, doc]),
      ),
    );
    expect(["P0001", "23514"]).toContain(onNote.code);
    // another business's document: refused, whichever business the row claims
    const theirContact = await newContact(outsider, otherOrg);
    const foreignDoc = await asAdmin(async (q) => {
      await q("update public.subscriptions set feature_overrides = '{\"documents\": true}' where organization_id = $1", [otherOrg]);
      return (
        await one<{ id: string }>(
          q,
          "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', 'X-1', 1) returning id",
          [otherOrg, theirContact],
        )
      ).id;
    });
    expect((await pgError(attach(owner, foreignDoc))).code).toMatch(/^(42501|23503)$/);
    expect((await pgError(attach(owner, foreignDoc, { orgId: otherOrg }))).code).toBe("42501");
  });

  it("Storage follows the file's row: only the uploader puts the object; only readers of the document get it", async () => {
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const doc = await record(owner, { deal: await newDeal(owner) });
      const file = await attach(owner, doc);
      expect((await pgError(run(admin, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [file.storage_path])))).code).toBe("42501");
      await putObject(owner, file.storage_path, 1000, "application/pdf");
      const objects = (u: U) => run(u, (q) => count(q, "select 1 from storage.objects where bucket_id = 'record-files' and name = $1", [file.storage_path]));
      expect(await objects(owner)).toBe(1);
      expect(await objects(admin)).toBe(1);
      for (const u of [member, keyHolder, outsider]) expect(await objects(u), u.email).toBe(0);
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("purging the deal or contact keeps the document and its file (both are the business's records)", async () => {
    const contact = await newContact(owner);
    const doc = await record(owner, { contact });
    const file = await attach(owner, doc);
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    await run(owner, (q) => q("delete from public.contacts where id = $1", [contact]));
    expect(await asAdmin((q) => count(q, "select 1 from public.accounting_documents where id = $1 and contact_id is null", [doc]))).toBe(1);
    expect(await exists(file.id)).toBe(1);
    // the document has no parent now: owners, admins and managers read it, and its file
    for (const u of [owner, admin, manager]) expect(await visible(u, file.id), u.email).toBe(1);
    expect(await visible(member, file.id)).toBe(0);
  });
});

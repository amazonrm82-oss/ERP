import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type F = { id: string; storage_path: string; previous_id: string | null };

/**
 * PAY-01 follow-up (lane ד): a recorded payment takes a file (a PDF or an image of the receipt or confirmation) the way a
 * document does (211). Reading follows the payment; adding needs the payment rules; one current file per payment. And a
 * privacy erasure erases the entries of the files of the documents and payments it reaches (a file's name may carry the
 * customer's name); the files themselves stay with their document or payment.
 */
describe("files on payments, and their erasure", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string;
  let pipelineId: string, stageId: string;
  let n = 0;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const newContact = (u: U) =>
    run(u, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'מיכל לוי', $2) returning id", [org, u.id])).id);
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
  const pay = (u: U, parent: { deal?: string; contact?: string }) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method) values ($1, $2, $3, 5000, 'transfer') returning id", [
            org,
            parent.deal ?? null,
            parent.contact ?? null,
          ])
        ).id,
    );
  const recordDoc = (u: U, contact: string) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, 'receipt', $3, 5000) returning id",
            [org, contact, `PF-${++n}`],
          )
        ).id,
    );
  const attach = (u: U, column: "payment_id" | "accounting_document_id", id: string, opts: { type?: string; previous?: string | null; name?: string } = {}) =>
    run(u, (q) =>
      one<F>(
        q,
        `insert into public.files (organization_id, ${column}, name, mime_type, size_bytes, previous_id) values ($1, $2, $3, $4, 1000, $5) returning id, storage_path, previous_id`,
        [org, id, opts.name ?? "קבלה.pdf", opts.type ?? "application/pdf", opts.previous ?? null],
      ),
    );
  const visible = (u: U, fileId: string) => run(u, (q) => count(q, "select 1 from public.files where id = $1", [fileId]));
  const remove = (u: U, fileId: string) => run(u, async (q) => (await q("delete from public.files where id = $1", [fileId])).rowCount);
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));
  const ALL = { payments: true, documents: true, granular_permissions: true };

  beforeAll(async () => {
    owner = await createUser("pfile-owner");
    org = await createOrg(owner.id, "עסק התשלומים");
    admin = await addMember(org, owner.id, "admin", "pfile-admin");
    manager = await addMember(org, owner.id, "manager", "pfile-manager");
    member = await addMember(org, owner.id, "member", "pfile-member");
    keyHolder = await addMember(org, owner.id, "member", "pfile-key");
    viewer = await addMember(org, owner.id, "viewer", "pfile-viewer");
    outsider = await createUser("pfile-outsider");
    await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    await setFeatures(ALL);
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, keyHolder.id]));
  });

  it("whoever records payments attaches a file; a member without the key, a viewer, an outsider and a documents-only key holder cannot", async () => {
    const contact = await newContact(owner);
    for (const u of [owner, admin, manager, keyHolder]) {
      const payment = await pay(owner, { contact });
      const file = await attach(u, "payment_id", payment);
      expect(file.storage_path, u.email).toBe(`${org}/${file.id}`);
    }
    const payment = await pay(owner, { contact });
    for (const u of [member, viewer, outsider]) expect((await pgError(attach(u, "payment_id", payment))).code, u.email).toBe("42501");
    // the payments key does not open documents, and the documents key does not open payments
    const doc = await recordDoc(owner, contact);
    expect((await pgError(attach(keyHolder, "accounting_document_id", doc))).code).toBe("42501");
  });

  it("needs the plan's payments key, and a PDF or an image", async () => {
    const payment = await pay(owner, { contact: await newContact(owner) });
    await setFeatures({ ...ALL, payments: false });
    try {
      expect((await pgError(attach(owner, "payment_id", payment))).hint).toBe("feature:payments");
      expect((await pgError(attach(member, "payment_id", payment))).code).toBe("42501");
    } finally {
      await setFeatures(ALL);
    }
    for (const type of ["application/zip", "text/csv", "image/svg+xml"]) expect((await pgError(attach(owner, "payment_id", payment, { type }))).hint, type).toBe("file:document_type");
    const image = await attach(owner, "payment_id", payment, { type: "image/jpeg" });
    await run(owner, (q) => q("insert into storage.objects (bucket_id, name) values ('record-files', $1)", [image.storage_path]));
    await asAdmin((q) => q("update storage.objects set metadata = '{\"size\": 900, \"mimetype\": \"text/html\"}' where bucket_id = 'record-files' and name = $1", [image.storage_path]));
    expect(await run(owner, async (q) => (await one<{ r: unknown }>(q, "select public.confirm_file_upload($1, $2) as r", [org, image.id])).r)).toEqual({ ok: false, reason: "type" });
  });

  it("is read by whoever reads the payment, and removed by nobody once it arrived (owner, 20 October 2026)", async () => {
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // the owner's deal: under "own" the members and the key holder do not read it, so neither its payment nor the file
      const payment = await pay(owner, { deal: await newDeal(owner) });
      const byOwner = await attach(owner, "payment_id", payment);
      for (const u of [owner, admin]) expect(await visible(u, byOwner.id), u.email).toBe(1);
      for (const u of [member, keyHolder, viewer, outsider]) expect(await visible(u, byOwner.id), u.email).toBe(0);
      expect((await pgError(attach(keyHolder, "payment_id", payment))).code).toBe("42501");
      // confirmed (what confirm_file_upload does once the object is there): nobody removes it, a server path neither
      await asAdmin((q) => q("update public.files set unconfirmed_since = null where id = $1", [byOwner.id]));
      for (const u of [owner, admin, member, keyHolder, viewer, outsider]) expect(await remove(u, byOwner.id), u.email).toBe(0);
      expect((await pgError(asAdmin((q) => q("delete from public.files where id = $1", [byOwner.id])))).hint).toBe("file:kept");
      expect(await visible(owner, byOwner.id)).toBe(1);
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("keeps one current file per payment; a cancelled payment still takes one", async () => {
    const payment = await pay(owner, { contact: await newContact(owner) });
    const first = await attach(owner, "payment_id", payment);
    const second = await attach(keyHolder, "payment_id", payment);
    expect(second.previous_id).toBe(first.id);
    expect((await pgError(attach(owner, "payment_id", payment, { previous: first.id }))).hint).toBe("file:version_taken");
    await run(owner, (q) => q("update public.payments set status = 'cancelled', cancel_reason = 'נרשם פעמיים' where id = $1", [payment]));
    const third = await attach(manager, "payment_id", payment);
    expect(third.previous_id).toBe(second.id);
    expect(await asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.payments where id = $1", [payment])).status)).toBe("cancelled");
  });

  it("one subject only: never a payment and a document, or a record, at once", async () => {
    const contact = await newContact(owner);
    const payment = await pay(owner, { contact });
    const doc = await recordDoc(owner, contact);
    for (const [cols, params] of [
      ["payment_id, accounting_document_id", [payment, doc]],
      ["payment_id, contact_id", [payment, contact]],
    ] as const) {
      const e = await pgError(
        run(owner, (q) => q(`insert into public.files (organization_id, ${cols}, name, mime_type, size_bytes) values ($1, $2, $3, 'x.pdf', 'application/pdf', 1)`, [org, ...params])),
      );
      expect(e.code, cols).toBe("23514");
    }
  });

  it("a privacy erasure erases the entries of the files of the documents and payments it reaches; the files stay", async () => {
    const contact = await newContact(owner);
    const other = await newContact(owner);
    const payment = await pay(owner, { contact });
    const doc = await recordDoc(owner, contact);
    const otherPayment = await pay(owner, { contact: other });
    // the current files, and uploads that never arrived, removed by their uploader before the erasure (the one removal
    // there is): a removed row's entry holds the row (the name included); an added file's entry holds no values (app.audit_row)
    const paymentFile = await attach(owner, "payment_id", payment, { name: "קבלה מיכל לוי.pdf" });
    const docFile = await attach(owner, "accounting_document_id", doc, { name: "חשבונית מיכל לוי.pdf" });
    const paymentGone = await attach(owner, "payment_id", payment, { name: "קבלה מיכל לוי 2.pdf" });
    const docGone = await attach(owner, "accounting_document_id", doc, { name: "חשבונית מיכל לוי 2.pdf" });
    const otherGone = await attach(owner, "payment_id", otherPayment, { name: "קבלה מיכל לוי 3.pdf" });
    for (const f of [paymentGone, docGone, otherGone]) expect(await remove(owner, f.id)).toBe(1);
    const named = (fileId: string) =>
      asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'files' and entity_id = $1 and changes::text like '%מיכל%'", [fileId]));
    for (const f of [paymentGone, docGone, otherGone]) expect(await named(f.id)).toBe(1);
    const entries = (fileId: string) =>
      asAdmin((q) => count(q, "select 1 from public.audit_log where entity_type = 'files' and entity_id = $1 and changes <> '{\"erased\": true}'::jsonb", [fileId]));
    for (const f of [paymentFile, docFile]) expect(await entries(f.id)).toBe(1);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [contact])).rowCount)).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));

    for (const f of [paymentGone, docGone]) expect(await named(f.id)).toBe(0);
    // every entry of the reached documents' and payments' files is erased, the current files' too
    for (const f of [paymentFile, docFile, paymentGone, docGone]) expect(await entries(f.id)).toBe(0);
    // another customer's payment file keeps its entries
    expect(await named(otherGone.id)).toBe(1);
    // the files stay with their payment and document (business records), as those do
    for (const f of [paymentFile, docFile]) expect(await asAdmin((q) => count(q, "select 1 from public.files where id = $1", [f.id]))).toBe(1);
  });
});

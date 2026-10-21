import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Doc = {
  status: string;
  cancel_reason: string | null;
  cancelled_by: string | null;
  created_by: string | null;
  deal_id: string | null;
  contact_id: string | null;
  number: string;
};

/**
 * DOC-01 (owner, 20 October 2026): an accounting document issued outside the system is recorded on a deal or a contact by
 * owners, admins and managers, or a holder of the personal key `documents`; it is read by whoever reads its deal, else its
 * contact; the same type and number once per business; never deleted, only cancelled with a reason; nothing else changes.
 */
describe("accounting documents (DOC-01)", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const doc = (id: string) =>
    asAdmin((q) =>
      one<Doc>(q, "select status, cancel_reason, cancelled_by, created_by, deal_id, contact_id, number from public.accounting_documents where id = $1", [id]),
    );
  const newContact = (u: U, name: string, orgId = org) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [
            orgId,
            name,
            u.id,
          ])
        ).id,
    );
  const newDeal = (u: U, contact: string | null = null) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.deals (organization_id, name, pipeline_id, stage_id, contact_id, owner_id) values ($1, 'עסקה', $2, $3, $4, $5) returning id",
            [org, pipelineId, stageId, contact, u.id],
          )
        ).id,
    );
  const record = (u: U, fields: { deal?: string | null; contact?: string | null; type?: string; number: string; amount?: number }, orgId = org) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.accounting_documents (organization_id, deal_id, contact_id, doc_type, number, amount_agorot) values ($1, $2, $3, $4, $5, $6) returning id",
            [orgId, fields.deal ?? null, fields.contact ?? null, fields.type ?? "tax_invoice", fields.number, fields.amount ?? 117000],
          )
        ).id,
    );
  const cancel = (u: U, id: string, reason: string | null) =>
    run(u, async (q) => (await q("update public.accounting_documents set status = 'cancelled', cancel_reason = $2 where id = $1", [id, reason])).rowCount);
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));

  beforeAll(async () => {
    owner = await createUser("doc-owner");
    org = await createOrg(owner.id, "עסק המסמכים");
    admin = await addMember(org, owner.id, "admin", "doc-admin");
    manager = await addMember(org, owner.id, "manager", "doc-manager");
    member = await addMember(org, owner.id, "member", "doc-member");
    keyHolder = await addMember(org, owner.id, "member", "doc-key");
    viewer = await addMember(org, owner.id, "viewer", "doc-viewer");
    outsider = await createUser("doc-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    await setFeatures({ documents: true, granular_permissions: true });
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{documents}')", [org, keyHolder.id]));
  });

  it("owners, admins, managers and the key's holder record; a member without the key, a viewer and an outsider cannot", async () => {
    const contact = await newContact(owner, "דנה");
    for (const [i, u] of [owner, admin, manager, keyHolder].entries()) {
      const id = await record(u, { contact, number: `R-${i}` });
      expect((await doc(id)).created_by, u.email).toBe(u.id);
    }
    for (const u of [member, viewer, outsider]) expect((await pgError(record(u, { contact, number: `NO-${u.email}` }))).code, u.email).toBe("42501");
    // without the plan key nobody records
    await setFeatures({ documents: false, granular_permissions: true });
    try {
      expect((await pgError(record(owner, { contact, number: "OFF-1" }))).code).toBe("42501");
    } finally {
      await setFeatures({ documents: true, granular_permissions: true });
    }
    // the key works only while the plan has granular permissions (PRM-01)
    await setFeatures({ documents: true, granular_permissions: false });
    try {
      expect((await pgError(record(keyHolder, { contact, number: "NOKEY-1" }))).code).toBe("42501");
    } finally {
      await setFeatures({ documents: true, granular_permissions: true });
    }
  });

  it("needs a live deal or contact the recorder reads; reading follows the deal, else the contact", async () => {
    expect((await pgError(record(owner, { number: "P-1" }))).hint).toBe("document:parent");
    const contact = await newContact(member, "רון");
    const deal = await newDeal(member, contact);
    const onDeal = await record(manager, { deal, number: "D-1" });
    const onContact = await record(manager, { contact, number: "C-1" });
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      // the member owns both: reads both; the key holder (another member) reads neither
      expect(await run(member, (q) => count(q, "select 1 from public.accounting_documents where id = any($1)", [[onDeal, onContact]]))).toBe(2);
      expect(await run(keyHolder, (q) => count(q, "select 1 from public.accounting_documents where id = any($1)", [[onDeal, onContact]]))).toBe(0);
      // and records nothing on a record they cannot read
      expect((await pgError(record(keyHolder, { contact, number: "HIDDEN-1" }))).code).toBe("42501");
      expect(
        await run(
          keyHolder,
          async (q) => (await q("update public.accounting_documents set status = 'cancelled', cancel_reason = 'x' where id = $1", [onDeal])).rowCount,
        ),
      ).toBe(0);
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // a contact in the recycle bin takes no new document
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect((await pgError(record(owner, { contact, number: "BIN-1" }))).code).toBe("42501");
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [contact]));
    // nobody outside the business reads them
    expect(await run(outsider, (q) => count(q, "select 1 from public.accounting_documents where organization_id = $1", [org]))).toBe(0);
    expect(
      await asAnon((q) => q("select 1 from public.accounting_documents")).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      ),
    ).toBe("42501");
  });

  it("the same type and number once per business (cancelled ones too); another type or business is free", async () => {
    const contact = await newContact(owner, "יעל");
    const first = await record(owner, { contact, number: "  INV-100 " });
    expect((await doc(first)).number).toBe("INV-100");
    expect((await pgError(record(admin, { contact, number: "INV-100" }))).hint).toBe("document:duplicate");
    await cancel(owner, first, "נרשם בטעות");
    expect((await pgError(record(admin, { contact, number: "INV-100" }))).hint).toBe("document:duplicate");
    await record(admin, { contact, type: "receipt", number: "INV-100" });
    const theirs = await newContact(outsider, "אחר", otherOrg);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"documents\": true}' where organization_id = $1", [otherOrg]));
    await record(outsider, { contact: theirs, number: "INV-100" }, otherOrg);
    // an outsider learns nothing about this business's numbers: a plain refusal, not the duplicate hint
    const probe = await pgError(record(outsider, { contact, number: "INV-100" }));
    expect(probe.code).toBe("42501");
    expect(probe.hint ?? null).toBeNull();
    // a number up to 40 characters
    expect((await pgError(record(owner, { contact, number: "x".repeat(41) }))).code).toBe("23514");
  });

  it("never deleted; cancelled once with a reason by who may record; nothing else changes", async () => {
    const contact = await newContact(owner, "שירה");
    const id = await record(manager, { contact, number: "K-1" });
    // no delete for anyone (no grant)
    for (const u of [owner, manager])
      expect((await pgError(run(u, (q) => q("delete from public.accounting_documents where id = $1", [id])))).code, u.email).toBe("42501");
    // nothing but the state and the reason may be sent; the server refuses even its own change of the facts
    expect((await pgError(run(owner, (q) => q("update public.accounting_documents set number = 'K-2' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asAdmin((q) => q("update public.accounting_documents set amount_agorot = 1 where id = $1", [id])))).hint).toBe("document:frozen");
    // a member without the key cancels nothing
    expect(await cancel(member, id, "סיבה")).toBe(0);
    expect((await pgError(cancel(manager, id, "   "))).hint).toBe("document:cancel_reason");
    expect((await pgError(cancel(manager, id, null))).hint).toBe("document:cancel_reason");
    expect(await cancel(manager, id, " הלקוח ביטל ")).toBe(1);
    expect(await doc(id)).toMatchObject({ status: "cancelled", cancel_reason: "הלקוח ביטל", cancelled_by: manager.id });
    // never back, never another reason
    expect(
      (await pgError(run(owner, (q) => q("update public.accounting_documents set status = 'active', cancel_reason = null where id = $1", [id])))).hint,
    ).toBe("document:cancelled");
    expect((await pgError(cancel(owner, id, "סיבה אחרת"))).hint).toBe("document:cancelled");
    // the cancellation is in the audit log
    const entry = await asAdmin((q) =>
      one<{ changes: Record<string, unknown> }>(
        q,
        "select changes from public.audit_log where entity_type = 'accounting_documents' and entity_id = $1 and action = 'update' order by id desc limit 1",
        [id],
      ),
    );
    expect(JSON.stringify(entry.changes)).toContain("הלקוח ביטל");
  });

  it("a purged deal or contact leaves its documents; a contact merge moves them to the kept contact", async () => {
    const contact = await newContact(owner, "אורי");
    const deal = await newDeal(owner, contact);
    const onDeal = await record(owner, { deal, number: "PG-1" });
    const onContact = await record(owner, { contact, number: "PG-2" });
    await run(owner, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    expect(await run(owner, async (q) => (await q("delete from public.deals where id = $1", [deal])).rowCount)).toBe(1);
    expect(await doc(onDeal)).toMatchObject({ deal_id: null, contact_id: null, status: "active" });
    // left with neither: read by owners, admins and managers by role
    expect(await run(manager, (q) => count(q, "select 1 from public.accounting_documents where id = $1", [onDeal]))).toBe(1);
    expect(await run(member, (q) => count(q, "select 1 from public.accounting_documents where id = $1", [onDeal]))).toBe(0);
    expect((await doc(onContact)).contact_id).toBe(contact);

    const keep = await newContact(owner, "אורי שמור");
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, contact]));
    expect((await doc(onContact)).contact_id).toBe(keep);
  });

  it("a privacy erasure of the purged contact or deal empties the cancel reason and the document's entries; the facts stay", async () => {
    const contact = await newContact(owner, "מיכל");
    const deal = await newDeal(owner, contact);
    const onContact = await record(owner, { contact, number: "ER-1", amount: 50000 });
    const onDeal = await record(owner, { deal, type: "receipt", number: "ER-2", amount: 7000 });
    const untouched = await record(owner, { contact: await newContact(owner, "אחר"), number: "ER-3" });
    expect(await cancel(owner, onContact, "מיכל לוי ביקשה לבטל")).toBe(1);
    expect(await cancel(owner, onDeal, "מיכל לוי שילמה במזומן")).toBe(1);
    expect(await cancel(owner, untouched, "סיבה של מישהו אחר")).toBe(1);
    const entries = (id: string) =>
      asAdmin((q) =>
        count(q, "select 1 from public.audit_log where entity_type = 'accounting_documents' and entity_id = $1 and changes::text like '%מיכל%'", [id]),
      );
    expect(await entries(onContact)).toBeGreaterThan(0);

    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [contact])).rowCount)).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, contact]));
    const facts = (id: string) =>
      asAdmin((q) =>
        one<Record<string, unknown>>(
          q,
          "select doc_type, number, amount_agorot::int as amount, status, cancel_reason, contact_id from public.accounting_documents where id = $1",
          [id],
        ),
      );
    expect(await facts(onContact)).toEqual({
      doc_type: "tax_invoice",
      number: "ER-1",
      amount: 50000,
      status: "cancelled",
      cancel_reason: "הסיבה נמחקה (מחיקת פרטיות)",
      contact_id: null,
    });
    expect(await entries(onContact)).toBe(0);
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.audit_log where entity_type = 'accounting_documents' and entity_id = $1 and changes <> '{\"erased\": true}'::jsonb", [
          onContact,
        ]),
      ),
    ).toBe(0);
    // RVW-45: the document recorded on the contact's deal (no contact on it) is reached too; another customer's is untouched
    expect((await facts(onDeal)).cancel_reason).toBe("הסיבה נמחקה (מחיקת פרטיות)");
    expect(await entries(onDeal)).toBe(0);
    expect((await facts(untouched)).cancel_reason).toBe("סיבה של מישהו אחר");
    await run(owner, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    expect(await run(owner, async (q) => (await q("delete from public.deals where id = $1", [deal])).rowCount)).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, deal]));
    expect(await facts(onDeal)).toMatchObject({ number: "ER-2", amount: 7000, cancel_reason: "הסיבה נמחקה (מחיקת פרטיות)" });
    expect(await entries(onDeal)).toBe(0);
    // a person cannot use that path: the reason of a cancelled document stays as it is
    expect(
      (await pgError(run(owner, (q) => q("update public.accounting_documents set cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)' where id = $1", [untouched]))))
        .hint,
    ).toBe("document:cancelled");
    // the erase path takes only that one text on a cancelled document: any other reason, or any fact, is still refused
    for (const set of ["cancel_reason = 'אחר'", "amount_agorot = 1, cancel_reason = 'הסיבה נמחקה (מחיקת פרטיות)'"]) {
      const err = await pgError(
        asAdmin(async (q) => {
          await q("select set_config('app.document_server', 'erase', true)");
          await q(`update public.accounting_documents set ${set} where id = $1`, [untouched]);
        }),
      );
      expect(["document:cancelled", "document:frozen"], set).toContain(err.hint);
    }
  });
});

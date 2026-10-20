import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Pay = {
  status: string;
  amount_agorot: string;
  method: string;
  installments: number | null;
  reference: string | null;
  note: string | null;
  created_by: string | null;
  updated_by: string | null;
  deal_id: string | null;
  contact_id: string | null;
};

/**
 * PAY-01, PAY-05, PAY-06: a payment received is recorded on a deal or a contact by owners, admins and managers, or a holder of
 * the personal key `record_payments`; it is read by whoever reads its deal, else its contact. A recorder moves its status
 * (recorded, confirmed, failed); correcting it, marking it refunded and cancelling it (with a reason; it is never deleted) are
 * for owners and admins; its links never
 * change by hand; everything is audited.
 */
describe("payments (PAY-01, PAY-05, PAY-06)", () => {
  let owner: U, admin: U, manager: U, member: U, keyHolder: U, viewer: U, outsider: U;
  let org: string, otherOrg: string;
  let pipelineId: string, stageId: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const pay = (id: string) =>
    asAdmin((q) =>
      one<Pay>(
        q,
        "select status, amount_agorot, method, installments, reference, note, created_by, updated_by, deal_id, contact_id from public.payments where id = $1",
        [id],
      ),
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
  const record = (
    u: U,
    fields: {
      deal?: string | null;
      contact?: string | null;
      amount?: number;
      method?: string;
      installments?: number | null;
      reference?: string | null;
      note?: string | null;
      status?: string;
    },
    orgId = org,
  ) =>
    run(
      u,
      async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.payments (organization_id, deal_id, contact_id, amount_agorot, method, installments, reference, note, status) values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, 'recorded')) returning id",
            [
              orgId,
              fields.deal ?? null,
              fields.contact ?? null,
              fields.amount ?? 117000,
              fields.method ?? "transfer",
              fields.installments ?? null,
              fields.reference ?? null,
              fields.note ?? null,
              fields.status ?? null,
            ],
          )
        ).id,
    );
  const update = (u: U, id: string, set: string, params: unknown[] = []) =>
    run(u, async (q) => (await q(`update public.payments set ${set} where id = $1`, [id, ...params])).rowCount);
  const setFeatures = (features: Record<string, boolean>) =>
    asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(features)]));

  beforeAll(async () => {
    owner = await createUser("pay-owner");
    org = await createOrg(owner.id, "עסק התשלומים");
    admin = await addMember(org, owner.id, "admin", "pay-admin");
    manager = await addMember(org, owner.id, "manager", "pay-manager");
    member = await addMember(org, owner.id, "member", "pay-member");
    keyHolder = await addMember(org, owner.id, "member", "pay-key");
    viewer = await addMember(org, owner.id, "viewer", "pay-viewer");
    outsider = await createUser("pay-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    const pipe = await defaultPipeline(org);
    pipelineId = pipe.pipelineId;
    stageId = pipe.stages.find((s) => s.kind === "open")!.id;
    await setFeatures({ payments: true, granular_permissions: true });
    await run(owner, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, keyHolder.id]));
  });

  it("owners, admins, managers and the key's holder record; a member without the key, a viewer and an outsider cannot", async () => {
    const contact = await newContact(owner, "דנה");
    for (const u of [owner, admin, manager, keyHolder]) {
      const id = await record(u, { contact });
      expect(await pay(id), u.email).toMatchObject({ created_by: u.id, updated_by: u.id, status: "recorded" });
    }
    for (const u of [member, viewer, outsider]) expect((await pgError(record(u, { contact }))).code, u.email).toBe("42501");
    // without the plan key nobody records
    await setFeatures({ payments: false, granular_permissions: true });
    try {
      expect((await pgError(record(owner, { contact }))).code).toBe("42501");
    } finally {
      await setFeatures({ payments: true, granular_permissions: true });
    }
    // the key works only while the plan has granular permissions (PRM-01)
    await setFeatures({ payments: true, granular_permissions: false });
    try {
      expect((await pgError(record(keyHolder, { contact }))).code).toBe("42501");
    } finally {
      await setFeatures({ payments: true, granular_permissions: true });
    }
  });

  it("the fields: a positive amount, the closed method list, instalments on credit only, trimmed reference and note, a new payment recorded or confirmed", async () => {
    const contact = await newContact(owner, "רות");
    // PAY-05: credit without a number is one payment; credit takes 1..36; other methods take none
    expect((await pay(await record(owner, { contact, method: "credit" }))).installments).toBe(1);
    expect((await pay(await record(owner, { contact, method: "credit", installments: 12 }))).installments).toBe(12);
    expect((await pgError(record(owner, { contact, method: "credit", installments: 37 }))).code).toBe("23514");
    expect((await pgError(record(owner, { contact, method: "cash", installments: 3 }))).code).toBe("23514");
    expect((await pgError(record(owner, { contact, method: "barter" }))).code).toBe("23514");
    expect((await pgError(record(owner, { contact, amount: 0 }))).code).toBe("23514");
    expect((await pgError(record(owner, { contact, amount: -100 }))).code).toBe("23514");
    for (const method of ["credit", "transfer", "cash", "cheque", "bit_paybox", "standing_order", "other"]) {
      expect((await pay(await record(owner, { contact, method }))).method).toBe(method);
    }
    const trimmed = await record(owner, { contact, reference: "  4567 ", note: "   " });
    expect(await pay(trimmed)).toMatchObject({ reference: "4567", note: null });
    expect((await pgError(record(owner, { contact, reference: "x".repeat(101) }))).code).toBe("23514");
    expect((await pay(await record(owner, { contact, status: "confirmed" }))).status).toBe("confirmed");
    for (const status of ["failed", "refunded"]) expect((await pgError(record(owner, { contact, status }))).hint, status).toBe("payment:status");
    // the currency is ILS only, as every money table
    expect(
      (
        await pgError(
          run(owner, (q) =>
            q("insert into public.payments (organization_id, contact_id, amount_agorot, method, currency) values ($1, $2, 1, 'cash', 'USD')", [org, contact]),
          ),
        )
      ).code,
    ).toBe("23514");
  });

  it("needs a live deal or contact the recorder reads; reading follows the deal, else the contact", async () => {
    expect((await pgError(record(owner, {}))).hint).toBe("payment:parent");
    const contact = await newContact(member, "רון");
    const deal = await newDeal(member, contact);
    const onDeal = await record(manager, { deal, contact });
    const onContact = await record(manager, { contact });
    await run(owner, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await run(member, (q) => count(q, "select 1 from public.payments where id = any($1)", [[onDeal, onContact]]))).toBe(2);
      expect(await run(keyHolder, (q) => count(q, "select 1 from public.payments where id = any($1)", [[onDeal, onContact]]))).toBe(0);
      expect((await pgError(record(keyHolder, { contact }))).code).toBe("42501");
      expect(await update(keyHolder, onDeal, "status = 'confirmed'")).toBe(0);
    } finally {
      await run(owner, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // a record in the recycle bin takes no new payment
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contact]));
    expect((await pgError(record(owner, { contact }))).code).toBe("42501");
    await run(owner, (q) => q("update public.contacts set deleted_at = null where id = $1", [contact]));
    // nobody outside the business reads them, through this business's ids or its own
    expect(await run(outsider, (q) => count(q, "select 1 from public.payments where organization_id = $1", [org]))).toBe(0);
    expect(
      await asAnon((q) => q("select 1 from public.payments")).then(
        () => "ok",
        (e: { code?: string }) => e.code,
      ),
    ).toBe("42501");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"payments\": true}' where organization_id = $1", [otherOrg]));
    expect((await pgError(record(outsider, { contact }, otherOrg))).code).toBe("42501");
    expect((await pgError(record(outsider, { contact }))).code).toBe("42501");
  });

  it("a recorder moves the status; correcting, refunds and cancelling are for owners and admins; the links never change by hand", async () => {
    const contact = await newContact(owner, "שירה");
    const other = await newContact(owner, "שירה אחרת");
    const id = await record(keyHolder, { contact, method: "credit", installments: 3, reference: "A-1" });
    // the key holder and the manager move between recorded, confirmed and failed
    expect(await update(keyHolder, id, "status = 'confirmed'")).toBe(1);
    expect(await update(manager, id, "status = 'failed'")).toBe(1);
    expect(await update(manager, id, "status = 'recorded'")).toBe(1);
    expect((await pay(id)).updated_by).toBe(manager.id);
    // but correct nothing, mark nothing refunded and cancel nothing
    for (const u of [keyHolder, manager]) {
      for (const set of [
        "amount_agorot = 5",
        "paid_on = current_date - 1",
        "method = 'cash', installments = null",
        "installments = 6",
        "reference = 'B-2'",
        "note = 'x'",
        "status = 'refunded'",
        "status = 'cancelled', cancel_reason = 'סיבה'",
      ]) {
        expect((await pgError(update(u, id, set))).hint, `${u.email}: ${set}`).toBe("payment:correction");
      }
    }
    // nobody deletes a payment, owners included (no grant)
    for (const u of [owner, admin, manager]) {
      expect((await pgError(run(u, (q) => q("delete from public.payments where id = $1", [id])))).code, u.email).toBe("42501");
    }
    // a member without the key and a viewer change nothing
    for (const u of [member, viewer]) expect(await update(u, id, "status = 'confirmed'"), u.email).toBe(0);
    // the links and the history are not sent by a person at all, and the server refuses moving them
    for (const set of [
      "contact_id = $2",
      "deal_id = null",
      "created_by = $2",
      "updated_by = $2",
      "currency = 'ILS'",
      "cancelled_at = now()",
      "cancelled_by = $2",
    ]) {
      expect((await pgError(update(owner, id, set, set.includes("$2") ? [set.startsWith("contact") ? other : owner.id] : []))).code, set).toBe("42501");
    }
    expect((await pgError(asAdmin((q) => q("update public.payments set contact_id = $2 where id = $1", [id, other])))).hint).toBe("payment:frozen");
    // an admin corrects and marks refunded; the owner moves it back
    expect(await update(admin, id, "amount_agorot = 90000, method = 'cash', installments = null, reference = 'C-3', note = 'תוקן'")).toBe(1);
    expect(await pay(id)).toMatchObject({ amount_agorot: "90000", method: "cash", installments: null, reference: "C-3", note: "תוקן", updated_by: admin.id });
    expect(await update(admin, id, "status = 'refunded'")).toBe(1);
    expect((await pgError(update(manager, id, "status = 'confirmed'"))).hint).toBe("payment:correction");
    expect(await update(owner, id, "status = 'confirmed'")).toBe(1);
    // a reason goes only with a cancellation
    expect((await pgError(update(owner, id, "cancel_reason = 'x'"))).hint).toBe("payment:cancel_reason");
    // cancelling needs a reason; the time and person are the server's
    expect((await pgError(update(admin, id, "status = 'cancelled'"))).hint).toBe("payment:cancel_reason");
    expect((await pgError(update(admin, id, "status = 'cancelled', cancel_reason = '   '"))).hint).toBe("payment:cancel_reason");
    expect(await update(admin, id, "status = 'cancelled', cancel_reason = ' נרשם פעמיים '")).toBe(1);
    const cancelled = await asAdmin((q) =>
      one<{ status: string; cancel_reason: string; cancelled_by: string; at: boolean }>(
        q,
        "select status, cancel_reason, cancelled_by, cancelled_at is not null as at from public.payments where id = $1",
        [id],
      ),
    );
    expect(cancelled).toEqual({ status: "cancelled", cancel_reason: "נרשם פעמיים", cancelled_by: admin.id, at: true });
    // a cancelled payment stays cancelled and nothing in it changes, for owners too
    for (const set of ["status = 'confirmed', cancel_reason = null", "cancel_reason = 'אחרת'", "note = 'x'", "amount_agorot = 1"]) {
      expect((await pgError(update(owner, id, set))).hint, set).toBe("payment:cancelled");
    }
    // a new payment is never born cancelled, not even by the server
    expect(
      (
        await pgError(
          asAdmin((q) =>
            q(
              "insert into public.payments (organization_id, contact_id, amount_agorot, method, status, cancel_reason, cancelled_at) values ($1, $2, 1, 'cash', 'cancelled', 'x', now())",
              [org, contact],
            ),
          ),
        )
      ).hint,
    ).toBe("payment:status");
    // every change is in the audit log, the cancellation with its reason
    const updates = await asAdmin((q) =>
      count(q, "select 1 from public.audit_log where entity_type = 'payments' and entity_id = $1 and action = 'update'", [id]),
    );
    expect(updates).toBeGreaterThanOrEqual(7);
    const last = await asAdmin((q) =>
      one<{ actor_id: string; changes: Record<string, unknown> }>(
        q,
        "select actor_id, changes from public.audit_log where entity_type = 'payments' and entity_id = $1 and action = 'update' order by id desc limit 1",
        [id],
      ),
    );
    expect(last.actor_id).toBe(admin.id);
    expect(JSON.stringify(last.changes)).toContain("נרשם פעמיים");
    // nothing changes in a read-only business
    const kept = await record(owner, { contact });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await update(owner, kept, "status = 'confirmed'")).toBe(0);
      expect(await update(owner, kept, "status = 'cancelled', cancel_reason = 'x'")).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("a purged deal or contact leaves its payments; a contact merge moves them; an erasure empties the reference, note and cancel reason", async () => {
    const contact = await newContact(owner, "אורי");
    const deal = await newDeal(owner, contact);
    const onDeal = await record(owner, { deal, reference: "PG-1" });
    const onContact = await record(owner, { contact, reference: "PG-2", note: "שילם אורי כהן" });
    expect(await update(owner, onDeal, "status = 'cancelled', cancel_reason = 'אורי כהן ביקש לבטל'")).toBe(1);
    await run(owner, (q) => q("update public.deals set deleted_at = now() where id = $1", [deal]));
    expect(await run(owner, async (q) => (await q("delete from public.deals where id = $1", [deal])).rowCount)).toBe(1);
    expect(await pay(onDeal)).toMatchObject({ deal_id: null, contact_id: null, reference: "PG-1" });
    // left with neither: read by owners, admins and managers by role
    expect(await run(manager, (q) => count(q, "select 1 from public.payments where id = $1", [onDeal]))).toBe(1);
    expect(await run(member, (q) => count(q, "select 1 from public.payments where id = $1", [onDeal]))).toBe(0);

    const keep = await newContact(owner, "אורי שמור");
    await run(owner, (q) => q("select public.merge_records($1, 'contact', $2, $3, '{}'::jsonb)", [org, keep, contact]));
    expect((await pay(onContact)).contact_id).toBe(keep);

    // the kept contact is purged and erased: its payment keeps amount, date, method and status, loses reference and note
    await run(owner, (q) => q("update public.contacts set deleted_at = now() where id = $1", [keep]));
    expect(await run(owner, async (q) => (await q("delete from public.contacts where id = $1", [keep])).rowCount)).toBe(1);
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, keep]));
    expect(await pay(onContact)).toMatchObject({
      contact_id: null,
      reference: null,
      note: null,
      amount_agorot: "117000",
      method: "transfer",
      status: "recorded",
    });
    const leftover = await asAdmin((q) =>
      count(q, "select 1 from public.audit_log where entity_type = 'payments' and entity_id = $1 and changes::text like '%אורי כהן%'", [onContact]),
    );
    expect(leftover).toBe(0);
    // the deal's cancelled payment (erased deal) loses its reference and its cancel reason; it stays cancelled
    await run(owner, (q) => q("select public.audit_erase_record($1, 'deals', $2)", [org, deal]));
    const erased = await asAdmin((q) =>
      one<{ reference: string | null; amount_agorot: string; status: string; cancel_reason: string }>(
        q,
        "select reference, amount_agorot, status, cancel_reason from public.payments where id = $1",
        [onDeal],
      ),
    );
    expect(erased).toEqual({ reference: null, amount_agorot: "117000", status: "cancelled", cancel_reason: "הסיבה נמחקה (מחיקת פרטיות)" });
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.audit_log where entity_type = 'payments' and entity_id = $1 and changes::text like '%אורי כהן%'", [onDeal]),
      ),
    ).toBe(0);
    // the erase path takes only that: with the flag set, a manager still corrects nothing else
    const other = await record(owner, { contact: await newContact(owner, "אחר"), reference: "Z-1" });
    for (const set of ["amount_agorot = 1, reference = null, note = null", "status = 'refunded', reference = null, note = null"]) {
      const err = await pgError(
        run(manager, async (q) => {
          await q("select set_config('app.payment_server', 'erase', true)");
          await q(`update public.payments set ${set} where id = $1`, [other]);
        }),
      );
      expect(err.hint, set).toBe("payment:correction");
    }
    expect((await pay(other)).reference).toBe("Z-1");
  });
});

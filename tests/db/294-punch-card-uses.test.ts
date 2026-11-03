import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * PKG-02 (spec 22.9 defaults): a held meeting of a covered type uses one entry of the contact's card (once per meeting; the
 * card that expires first; never an expired, waiting or cancelled one); leaving 'held' or removing the meeting gives it
 * back; owners, admins and managers give an entry back with a reason. The cards themselves are tested in 293-punch-cards.
 */
describe("punch card entries (PKG-02)", () => {
  let owner: U, admin: U, manager: U, member: U, seller: U, stranger: U;
  let org: string;
  let typeA: string, typeB: string;
  let product: string;
  const FEATURES = { products: true, payments: true, punch_cards: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = <T>(u: U, fn: (q: Query) => Promise<T>) => asUser(u.id, fn);
  const contact = (name: string) =>
    run(owner, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, owner.id])).id);
  const pay = (contactId: string, amount = 1000000) =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, current_date, 'cash') returning id", [
          org,
          contactId,
          amount,
        ])
      ).id,
    );
  const punchProduct = (u: U, settings: { entries?: number | null; count?: number | null; unit?: string | null; types?: string[] | null } = {}) =>
    run(u, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
           values ($1, 'כרטיסייה 10 טיפולים', 'punch_card', 50000, $2, $3, $4, $5) returning id`,
          [org, settings.entries === undefined ? 10 : settings.entries, settings.count ?? null, settings.unit ?? null, settings.types === undefined ? [typeA] : settings.types],
        )
      ).id,
    );
  const open = (u: U, contactId: string, opts: { product?: string; payment?: string | null; activate?: boolean } = {}) =>
    run(u, async (q) =>
      (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, $4, $5) as id", [org, contactId, opts.product ?? product, opts.payment ?? null, opts.activate ?? false])).id,
    );
  const card = (id: string) =>
    asAdmin(async (q) =>
      one<{ status: string; expires_on: string | null; contact_id: string; manual: boolean; payment_id: string | null; total: number; used: number }>(
        q,
        `select c.status, c.expires_on::text, c.contact_id, c.activated_manually as manual, c.payment_id, c.entries_total as total,
                (select count(*)::int from public.punch_card_uses u where u.card_id = c.id and u.returned_at is null) as used
           from public.punch_cards c where c.id = $1`,
        [id],
      ),
    );
  const meeting = (contactId: string, type: string | null, status = "held", startsAt = "now()") =>
    run(owner, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, meeting_type_id, status)
           values ($1, 'טיפול', ${startsAt}, ${startsAt} + interval '1 hour', $2, $3, $4) returning id`,
          [org, contactId, type, status],
        )
      ).id,
    );
  const setStatus = (id: string, status: string) => run(owner, (q) => q("update public.meetings set status = $2 where id = $1", [id, status]));
  const liveUse = (meetingId: string) =>
    asAdmin(async (q) => (await q<{ id: string }>("select id from public.punch_card_uses where meeting_id = $1 and returned_at is null", [meetingId])).rows[0]?.id ?? null);

  beforeAll(async () => {
    owner = await createUser("pu-owner");
    org = await createOrg(owner.id, "סטודיו הכניסות");
    admin = await addMember(org, owner.id, "admin", "pu-admin");
    manager = await addMember(org, owner.id, "manager", "pu-manager");
    member = await addMember(org, owner.id, "member", "pu-member");
    seller = await addMember(org, owner.id, "member", "pu-seller");
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{record_payments}')", [org, seller.id]));
    stranger = await createUser("pu-stranger");
    await createOrg(stranger.id, "עסק זר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    const types = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 order by position, created_at, id", [org])).rows.map((r) => r.id),
    );
    [typeA, typeB] = types;
    product = await punchProduct(owner, { entries: 3, count: 3, unit: "months" });
  });

  it("a held meeting of a covered type uses one entry; leaving 'held' or removing it gives it back", async () => {
    const c = await contact("יעל");
    const id = await open(seller, c, { payment: await pay(c) });
    const m1 = await meeting(c, typeA);
    expect((await card(id)).used).toBe(1);
    // once per meeting: another status change around it never takes a second one
    await run(owner, (q) => q("update public.meetings set title = 'טיפול ראשון' where id = $1", [m1]));
    expect((await card(id)).used).toBe(1);
    await setStatus(m1, "planned");
    expect((await card(id)).used).toBe(0);
    await setStatus(m1, "held");
    expect((await card(id)).used).toBe(1);
    // another type, no type, a planned meeting: nothing
    await meeting(c, typeB);
    await meeting(c, null);
    await meeting(c, typeA, "planned");
    expect((await card(id)).used).toBe(1);
    // the entries run out: the fourth held meeting uses nothing
    await meeting(c, typeA);
    const m3 = await meeting(c, typeA);
    expect((await card(id)).used).toBe(3);
    const m4 = await meeting(c, typeA);
    expect(await liveUse(m4)).toBeNull();
    // removing a meeting gives its entry back
    await run(owner, (q) => q("delete from public.meetings where id = $1", [m3]));
    expect((await card(id)).used).toBe(2);
    expect(await asAdmin(async (q) => count(q, "select 1 from public.punch_card_uses where card_id = $1 and returned_at is not null and return_kind = 'meeting'", [id]))).toBeGreaterThan(0);
  });

  it("uses the card that expires first, never an expired, waiting or cancelled one", async () => {
    const c = await contact("דנה");
    const p = await pay(c);
    const noExpiry = await punchProduct(owner, { entries: 5 });
    const longer = await open(seller, c, { product: noExpiry, payment: p });
    const sooner = await open(seller, c, { payment: p });
    await meeting(c, typeA);
    expect((await card(sooner)).used).toBe(1);
    expect((await card(longer)).used).toBe(0);
    // a meeting held after the card's last day is not counted on it
    await asAdmin((q) => q("update public.punch_cards set expires_on = current_date - 1 where id = $1", [sooner]));
    await meeting(c, typeA);
    expect((await card(sooner)).used).toBe(1);
    expect((await card(longer)).used).toBe(1);
    // a meeting held before the last day still counts on it, even when marked later (activated before that day)
    await asAdmin((q) => q("update public.punch_cards set activated_at = now() - interval '10 days' where id = $1", [sooner]));
    await meeting(c, typeA, "held", "(now() - interval '3 days')");
    expect((await card(sooner)).used).toBe(2);
    // a waiting or cancelled card is never used
    const d = await contact("שירה");
    const waiting = await open(seller, d);
    await meeting(d, typeA);
    expect((await card(waiting)).used).toBe(0);
    const cancelled = await open(admin, d, { activate: true });
    await run(admin, (q) => q("select public.punch_card_cancel($1, $2, 'החזר כספי על כניסות שלא נוצלו')", [org, cancelled]));
    await meeting(d, typeA);
    expect((await card(cancelled)).used).toBe(0);
  });

  it("owners, admins and managers give a used entry back with a reason", async () => {
    const c = await contact("אורי");
    const id = await open(seller, c, { payment: await pay(c) });
    const m = await meeting(c, typeA);
    const use = (await liveUse(m))!;
    const giveBack = (u: U, reason: string) => run(u, (q) => q("select public.punch_card_use_return($1, $2, $3)", [org, use, reason]));
    expect((await pgError(giveBack(member, "טעות"))).code).toBe("42501");
    expect((await pgError(giveBack(seller, "טעות"))).code).toBe("42501");
    expect((await pgError(giveBack(stranger, "טעות"))).code).toBe("42501");
    expect(await pgError(giveBack(manager, "  "))).toMatchObject({ hint: "punch_card:reason" });
    await giveBack(manager, "הטיפול בוטל ברגע האחרון");
    expect((await card(id)).used).toBe(0);
    expect(await pgError(giveBack(admin, "שוב"))).toMatchObject({ hint: "punch_card_use:returned" });
    // reverting the meeting later changes nothing more, and holding it again uses an entry again
    await setStatus(m, "cancelled");
    expect((await card(id)).used).toBe(0);
    await setStatus(m, "held");
    expect((await card(id)).used).toBe(1);
  });

  it("a transferred card is used by its new contact's meetings; entries are read with the card and go with it", async () => {
    const c = await contact("מיכל");
    const d = await contact("רון");
    const id = await open(admin, c, { activate: true });
    await run(admin, (q) => q("select public.punch_card_transfer($1, $2, $3)", [org, id, d]));
    await meeting(c, typeA);
    expect((await card(id)).used).toBe(0);
    await meeting(d, typeA);
    expect((await card(id)).used).toBe(1);
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const seenUses = (u: U) => run(u, (q) => count(q, "select 1 from public.punch_card_uses where card_id = $1", [id]));
      expect(await seenUses(admin)).toBe(1);
      expect(await seenUses(member)).toBe(0);
      expect(await seenUses(stranger)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    // no client writes to the entries at all
    const use = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.punch_card_uses where card_id = $1", [id])).id);
    expect((await pgError(run(owner, (q) => q("update public.punch_card_uses set returned_at = now(), return_kind = 'meeting' where id = $1", [use])))).code).toBe("42501");
    expect((await pgError(run(owner, (q) => q("delete from public.punch_card_uses where id = $1", [use])))).code).toBe("42501");
    // purging the contact takes the card and its entries
    await asAdmin((q) => q("delete from public.contacts where id = $1", [d]));
    expect(await asAdmin((q) => count(q, "select 1 from public.punch_card_uses where card_id = $1", [id]))).toBe(0);
  });

  it("a meeting dated before the card's activation day uses nothing (review finding 4)", async () => {
    const c = await contact("עדי");
    const id = await open(seller, c, { payment: await pay(c) });
    await meeting(c, typeA, "held", "(now() - interval '3 days')");
    expect((await card(id)).used).toBe(0);
    await meeting(c, typeA);
    expect((await card(id)).used).toBe(1);
  });

  it("entries are in the action log, and the erasure reaches them (owner (87) ב)", async () => {
    const c = await contact("לוינסון");
    const d = await contact("מזרחי");
    // a card of the person's: an entry used and given back with a reason naming them, then transferred away
    const moved = await open(admin, c, { activate: true });
    const m2 = await meeting(c, typeA);
    const movedUse = (await liveUse(m2))!;
    await run(manager, (q) => q("select public.punch_card_use_return($1, $2, 'לוינסון לא הגיע')", [org, movedUse]));
    await run(admin, (q) => q("select public.punch_card_transfer($1, $2, $3)", [org, moved, d]));
    // a card that stays with the person and goes with the purge, with one used entry
    const gone = await open(admin, c, { activate: true });
    const m1 = await meeting(c, typeA);
    const goneUse = (await liveUse(m1))!;
    expect(await asAdmin(async (q) => (await one<{ c: string }>(q, "select card_id as c from public.punch_card_uses where id = $1", [goneUse])).c)).toBe(gone);
    const log = (id: string) => asAdmin(async (q) => (await q<{ action: string; changes: unknown }>("select action, changes from public.audit_log where entity_type = 'punch_card_uses' and entity_id = $1 order by id", [id])).rows);
    expect((await log(goneUse)).map((r) => r.action)).toEqual(["insert"]);
    expect(JSON.stringify(await log(movedUse))).toContain("לוינסון");
    await asAdmin((q) => q("delete from public.contacts where id = $1", [c]));
    await run(owner, (q) => q("select public.audit_erase_record($1, 'contacts', $2)", [org, c]));
    // the gone card's entry: every log entry erased (the delete entry too)
    const goneLog = await log(goneUse);
    expect(goneLog.map((r) => r.action)).toEqual(["insert", "delete"]);
    expect(goneLog.every((r) => JSON.stringify(r.changes) === '{"erased":true}')).toBe(true);
    // the transferred card's given-back entry: kept with its date, its reason neutral, no log entry naming the person
    expect(await asAdmin(async (q) => one(q, "select return_reason, return_kind from public.punch_card_uses where id = $1", [movedUse]))).toEqual({
      return_reason: "הנימוק נמחק (מחיקת פרטיות)",
      return_kind: "manual",
    });
    expect(JSON.stringify(await log(movedUse))).not.toContain("לוינסון");
  });
});

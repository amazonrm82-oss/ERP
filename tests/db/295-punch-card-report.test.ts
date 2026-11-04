import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

type Totals = {
  active: number;
  active_paid: number;
  active_manual: number;
  active_unpaid: number;
  pending: number;
  expired: number;
  expired_with_entries: number;
  entries_total: number;
  entries_used: number;
  entries_left: number;
  unearned: number | null;
  expired_value: number | null;
  expiring: number;
  expiring_entries: number;
};
type Report = {
  allowed: boolean;
  partial?: boolean;
  today?: string;
  days?: number;
  totals?: Totals;
  by_product?: Array<{ product_id: string; name: string; cards: number; current_cards: number; entries_total: number; entries_used: number; entries_left: number; utilisation: number | null; unearned: number | null }>;
  expiring_cards?: Array<{ card_id: string; contact_id: string; contact_name: string | null; name: string; expires_on: string; entries_left: number; entries_total: number; kind: string }>;
};

/**
 * PKG-07: the punch cards report. Active cards (paid, manual, unpaid), utilisation by product, cards expiring within N days
 * with entries left, and the money received for entries not used yet (price x left / total, half up per card, paid current
 * cards only). Partial with no money when the caller reads fewer cards than the business holds; nothing to an outsider or
 * without the plan key.
 */
describe("punch cards report (PKG-07)", () => {
  let owner: U, manager: U, rep: U, viewer: U, stranger: U;
  let org: string, otherOrg: string;
  let typeA: string;
  let productA: string, productB: string;
  const FEATURES = { products: true, payments: true, punch_cards: true };
  const cards: Record<string, string> = {};

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const report = (u: U, days = 30, o = org) =>
    asUser(u.id, async (q) => (await one<{ r: Report }>(q, "select public.report_punch_cards($1, $2) as r", [o, days])).r);
  const contact = (u: U, name: string) =>
    asUser(u.id, async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, u.id])).id);
  const pay = (contactId: string, amount = 1000000) =>
    asUser(owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.payments (organization_id, contact_id, amount_agorot, paid_on, method) values ($1, $2, $3, current_date, 'cash') returning id", [org, contactId, amount])).id,
    );
  const punchProduct = (name: string, price: number, entries: number, months: number | null) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, vat_kind, price_includes_vat, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
           values ($1, $2, 'punch_card', $3, 'taxable', true, $4, $5, $6, $7) returning id`,
          [org, name, price, entries, months, months === null ? null : "months", [typeA]],
        )
      ).id,
    );
  const open = (contactId: string, product: string, payment: string | null, activate = false) =>
    asUser(owner.id, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, $4, $5) as id", [org, contactId, product, payment, activate])).id);
  const held = (contactId: string) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, meeting_type_id, status)
         values ($1, 'טיפול', now(), now() + interval '1 hour', $2, $3, 'held')`,
        [org, contactId, typeA],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("pr-owner");
    org = await createOrg(owner.id, "סטודיו הדוחות");
    manager = await addMember(org, owner.id, "manager", "pr-manager");
    rep = await addMember(org, owner.id, "member", "pr-member");
    viewer = await addMember(org, owner.id, "viewer", "pr-viewer");
    stranger = await createUser("pr-stranger");
    otherOrg = await createOrg(stranger.id, "עסק זר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = any($1)", [[org, otherOrg], JSON.stringify(FEATURES)]));
    // a manager in no team reads only their own records
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    // VAT included in the product price, so a card's price is the product's price as typed
    typeA = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meeting_types where organization_id = $1 order by position, created_at, id limit 1", [org])).id);
    productA = await punchProduct("כרטיסייה 10", 100001, 10, 3);
    productB = await punchProduct("כרטיסייה 3 בלי תוקף", 30000, 3, null);

    const c1 = await contact(owner, "נועה");
    const c2 = await contact(owner, "רון");
    const c3 = await contact(manager, "שלי");
    // paid, current, 3 of 10 used, expiring within 30 days
    cards.paid = await open(c1, productA, await pay(c1));
    await held(c1);
    await held(c1);
    await held(c1);
    await asAdmin((q) => q("update public.punch_cards set expires_on = (now() at time zone 'Asia/Jerusalem')::date + 10 where id = $1", [cards.paid]));
    // manual activation: counted apart, no money
    cards.manual = await open(c2, productB, null, true);
    // a payment that stopped counting: counted apart, no money
    cards.unpaid = await open(c2, productA, await pay(c2));
    await asAdmin((q) => q("update public.punch_cards set payment_void_at = now() where id = $1", [cards.unpaid]));
    // expired with entries left: its share is expired_value, not unearned
    cards.expired = await open(c2, productB, await pay(c2));
    await asAdmin((q) => q("update public.punch_cards set expires_on = (now() at time zone 'Asia/Jerusalem')::date - 1 where id = $1", [cards.expired]));
    // pending: counted only
    cards.pending = await open(c2, productB, null);
    // cancelled: never counted
    const cancelled = await open(c2, productB, null);
    await asUser(owner.id, (q) => q("select public.punch_card_cancel($1, $2, 'טעות')", [org, cancelled]));
    // the member's own contact: a paid card, expiring in 40 days (outside the default window)
    cards.member = await open(c3, productB, await pay(c3));
    await asAdmin((q) => q("update public.punch_cards set expires_on = (now() at time zone 'Asia/Jerusalem')::date + 40 where id = $1", [cards.member]));
    await held(c3);
  });

  it("counts active cards by kind, utilisation by product and the money for entries not used yet", async () => {
    const r = await report(owner);
    expect(r.allowed).toBe(true);
    expect(r.partial).toBe(false);
    expect(r.days).toBe(30);
    const t = r.totals as Totals;
    expect(t).toMatchObject({
      active: 4, // paid, manual, unpaid, member (current)
      active_paid: 2,
      active_manual: 1,
      active_unpaid: 1,
      pending: 1,
      expired: 1,
      expired_with_entries: 1,
      entries_total: 10 + 3 + 10 + 3 + 3,
      entries_used: 3 + 1,
      entries_left: 7 + 3 + 10 + 2,
      expiring: 1,
      expiring_entries: 7,
    });
    // paid A: 100001 x 7 / 10 = 70000.7 -> 70001; member's B: 30000 x 2 / 3 = 20000; manual and unpaid carry no money
    expect(t.unearned).toBe(70001 + 20000);
    // the expired card's whole price (nothing used)
    expect(t.expired_value).toBe(30000);
    const a = r.by_product?.find((p) => p.product_id === productA);
    expect(a).toMatchObject({ name: "כרטיסייה 10", cards: 2, current_cards: 2, entries_total: 20, entries_used: 3, entries_left: 17, utilisation: 0.15, unearned: 70001 });
    const b = r.by_product?.find((p) => p.product_id === productB);
    expect(b).toMatchObject({ cards: 3, current_cards: 2, entries_total: 9, entries_used: 1, entries_left: 5, unearned: 20000 });
    expect(r.expiring_cards).toEqual([
      expect.objectContaining({ card_id: cards.paid, contact_name: "נועה", entries_left: 7, entries_total: 10, kind: "paid" }),
    ]);
  });

  it("the window of days is the caller's choice, 1..366", async () => {
    const r = await report(owner, 60);
    expect(r.totals?.expiring).toBe(2);
    expect(r.expiring_cards?.map((c) => c.card_id)).toEqual([cards.paid, cards.member]);
    for (const days of [0, 367]) {
      const e = await pgError(report(owner, days));
      expect(e.code).toBe("22023");
      expect(e.hint).toBe("report:days");
    }
  });

  it("a manager who reads only some cards gets a partial answer with no money", async () => {
    const r = await report(manager, 60);
    expect(r.partial).toBe(true);
    expect(r.totals).toMatchObject({ active: 1, active_paid: 1, entries_used: 1, unearned: null, expired_value: null, expiring: 1 });
    expect(r.by_product).toEqual([expect.objectContaining({ product_id: productB, cards: 1, unearned: null })]);
    expect(r.expiring_cards?.map((c) => c.card_id)).toEqual([cards.member]);
  });

  it("nothing to an outsider or without the plan key; another business's report holds none of these cards", async () => {
    expect(await report(stranger)).toEqual({ allowed: false });
    const other = await report(stranger, 30, otherOrg);
    expect(other.partial).toBe(false);
    expect(other.totals?.active).toBe(0);
    expect(other.by_product).toEqual([]);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, punch_cards: false })]));
    try {
      expect(await report(owner)).toEqual({ allowed: false });
      const e = await pgError(asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'punch_cards', 1)", [org])));
      expect(e.hint).toBe("feature:punch_cards");
    } finally {
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    }
    await asUser(owner.id, (q) => q("select public.log_export($1, 'report', 'punch_cards', 3)", [org]));
  });

  it("the count helpers answer nothing to a non-member, and used entries only for cards whose contact the caller reads", async () => {
    const r = await asUser(stranger.id, async (q) => one<{ cards: string | null; today: string | null }>(q, "select * from app.punch_card_report_facts($1)", [org]));
    expect(r ?? { cards: null, today: null }).toEqual({ cards: null, today: null });
    const ids = Object.values(cards);
    const used = (u: U) =>
      asUser(u.id, async (q) =>
        Object.fromEntries((await q<{ card_id: string; used: number }>("select * from app.punch_card_used_counts($1, $2)", [org, ids])).rows.map((x) => [x.card_id, x.used])),
      );
    expect(await used(stranger)).toEqual({});
    // the manager reads only their own contact's card; the owner reads them all, with the right counts
    expect(await used(manager)).toEqual({ [cards.member]: 1 });
    expect(await used(owner)).toMatchObject({ [cards.paid]: 3, [cards.member]: 1, [cards.manual]: 0 });
    // another business's id list gives nothing
    expect(await asUser(stranger.id, async (q) => (await q("select * from app.punch_card_used_counts($1, $2)", [otherOrg, ids])).rows)).toEqual([]);
  });

  it("the expired row's count is the paid cards its amount sums (review finding 2)", async () => {
    const yesterday = "(now() at time zone 'Asia/Jerusalem')::date - 1";
    const kept = await asAdmin(async (q) => (await one<{ e: string | null }>(q, "select expires_on::text as e from public.punch_cards where id = $1", [cards.unpaid])).e);
    await asAdmin((q) => q(`update public.punch_cards set expires_on = ${yesterday} where id = $1`, [cards.unpaid]));
    try {
      const t = (await report(owner)).totals as Totals & { expired_paid_with_entries: number };
      expect(t).toMatchObject({ expired: 2, expired_with_entries: 2, expired_paid_with_entries: 1, expired_value: 30000 });
    } finally {
      await asAdmin((q) => q("update public.punch_cards set expires_on = $2 where id = $1", [cards.unpaid, kept]));
    }
  });

  it("a card of a contact in the recycle bin stays counted with its money, and its expiring row says so", async () => {
    const contactId = await asAdmin(async (q) => (await one<{ contact_id: string }>(q, "select contact_id from public.punch_cards where id = $1", [cards.paid])).contact_id);
    const before = await report(owner);
    await asUser(owner.id, (q) => q("update public.contacts set deleted_at = now() where id = $1", [contactId]));
    try {
      const r = await report(owner);
      expect(r.partial).toBe(false);
      expect(r.totals?.unearned).toBe(before.totals?.unearned);
      expect(r.totals?.active).toBe(before.totals?.active);
      expect(r.expiring_cards).toEqual([expect.objectContaining({ card_id: cards.paid, contact_binned: true })]);
      expect(before.expiring_cards).toEqual([expect.objectContaining({ card_id: cards.paid, contact_binned: false })]);
    } finally {
      await asUser(owner.id, (q) => q("update public.contacts set deleted_at = null where id = $1", [contactId]));
    }
  });

  it("owner (118) ב: a member and a viewer get nothing, and may not export it even with the export grant", async () => {
    expect(await report(rep)).toEqual({ allowed: false });
    expect(await report(viewer)).toEqual({ allowed: false });
    await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{export}')", [org, rep.id]));
    try {
      const e = await pgError(asUser(rep.id, (q) => q("select public.log_export($1, 'report', 'punch_cards', 1)", [org])));
      expect(e.code).toBe("42501");
      // the same grant still exports another report
      await asUser(rep.id, (q) => q("select public.log_export($1, 'report', 'revenue', 1)", [org]));
    } finally {
      await asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, '{}')", [org, rep.id]));
    }
    // a manager may export it
    await asUser(manager.id, (q) => q("select public.log_export($1, 'report', 'punch_cards', 1)", [org]));
  });

  it("owner (117) ב: the expiring window is kept per user as 7, 14, 30 or 60 days only", async () => {
    const save = (u: U, days: unknown) =>
      asUser(u.id, (q) =>
        q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'punch_report', $2)", [org, JSON.stringify([{ days }])]),
      );
    for (const bad of [31, 0, "30"]) {
      const e = await pgError(save(owner, bad));
      expect(e.code).toBe("23514");
    }
    const e = await pgError(
      asUser(owner.id, (q) => q("insert into public.list_preferences (organization_id, object_type, columns) values ($1, 'punch_report', '[{\"days\": 7}, {\"days\": 14}]')", [org])),
    );
    expect(e.code).toBe("23514");
    await save(owner, 14);
    await save(manager, 60);
    // each user reads only their own row
    const mine = await asUser(owner.id, async (q) => (await q<{ columns: unknown }>("select columns from public.list_preferences where organization_id = $1 and object_type = 'punch_report'", [org])).rows);
    expect(mine).toEqual([{ columns: [{ days: 14 }] }]);
    await asUser(owner.id, (q) => q("delete from public.list_preferences where organization_id = $1 and object_type = 'punch_report'", [org]));
    await asUser(manager.id, (q) => q("delete from public.list_preferences where organization_id = $1 and object_type = 'punch_report'", [org]));
  });
});

import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Notice = { user_id: string; type: string; title: string; body: string; entity_type: string; entity_id: string };

/**
 * PKG-03 (rep side): app.send_punch_card_alerts sends ONE notice of kind punch_card per card and kind: few entries left
 * (1..low_entries, a never-used card too) and the last day near (expires_on within expiry_days, for a card activated before
 * that window opened: owner (131)). The contact's usable owner gets it, else the owners and admins; card name and numbers
 * only. Writable businesses with the plan key, from 08:00 in the business's zone.
 */
describe("punch card alerts (PKG-03)", () => {
  let owner: U, admin: U, rep: U, viewer: U;
  let org: string;
  let typeA: string;
  let product10: string, product2: string;
  let zone: string;
  const FEATURES = { products: true, payments: true, punch_cards: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = (orgs: string[] = [org]) => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.send_punch_card_alerts($1) as n", [orgs])).n);
  const contact = (ownerId: string | null, name = "לקוחה") =>
    asAdmin(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, $2, $3) returning id", [org, name, ownerId])).id);
  const punchProduct = (name: string, entries: number) =>
    asUser(owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, vat_kind, price_includes_vat, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
           values ($1, $2, 'punch_card', 10000, 'taxable', true, $3, 3, 'months', $4) returning id`,
          [org, name, entries, [typeA]],
        )
      ).id,
    );
  // an active card, activated p_activated days ago (business calendar), expiring in p_expires days (null = never)
  const card = async (contactId: string, product: string, activatedDaysAgo: number, expiresInDays: number | null) => {
    const id = await asUser(owner.id, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [org, contactId, product])).id);
    await asAdmin((q) =>
      q(
        `update public.punch_cards set activated_at = now() - make_interval(days => $2),
                expires_on = case when $3::int is null then null else (now() at time zone $4)::date + $3::int end
          where id = $1`,
        [id, activatedDaysAgo, expiresInDays, zone],
      ),
    );
    return id;
  };
  const use = (cardId: string, n: number) =>
    asAdmin((q) => q("insert into public.punch_card_uses (organization_id, card_id, used_on) select $1, $2, current_date from generate_series(1, $3)", [org, cardId, n]));
  const notices = (contactId: string) =>
    asAdmin(async (q) =>
      (
        await q<Notice>(
          "select user_id, type, title, body, entity_type, entity_id from public.notifications where organization_id = $1 and type = 'punch_card' and entity_id = $2 order by title, user_id",
          [org, contactId],
        )
      ).rows,
    );
  const sent = (cardId: string) =>
    asAdmin(async (q) =>
      (await q<{ kind: string }>("select kind from app.punch_card_alerts_sent where card_id = $1 and done_at is not null and not baseline order by kind", [cardId])).rows.map((r) => r.kind),
    );

  beforeAll(async () => {
    owner = await createUser("pa-owner");
    org = await createOrg(owner.id, "סטודיו ההתראות");
    admin = await addMember(org, owner.id, "admin", "pa-admin");
    rep = await addMember(org, owner.id, "member", "pa-member");
    viewer = await addMember(org, owner.id, "viewer", "pa-viewer");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    // a zone where it is now between 08:00 and 23:59, so the job's 08:00 rule passes whenever the test runs
    zone = await asAdmin(async (q) =>
      (
        await one<{ z: string }>(
          q,
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu']) z
            where extract(hour from now() at time zone z) between 8 and 23 limit 1`,
        )
      ).z,
    );
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    typeA = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meeting_types where organization_id = $1 order by position, created_at, id limit 1", [org])).id);
    product10 = await punchProduct("כרטיסייה 10 כניסות", 10);
    product2 = await punchProduct("כרטיסייה קטנה", 2);
    // (140) the job's first look at the business starts it (nothing to mark yet), so the cards below are "after release"
    await run();
  });

  it("few entries left: one notice to the contact's owner, card name and numbers only, never twice", async () => {
    const c = await contact(rep.id, "נועה ישראלי");
    const id = await card(c, product10, 30, null);
    await use(id, 7);
    // 3 left: not yet
    await run();
    expect(await notices(c)).toEqual([]);
    await use(id, 1);
    await run();
    const got = await notices(c);
    expect(got).toEqual([
      { user_id: rep.id, type: "punch_card", title: "כרטיסייה: נשארו 2 כניסות", body: "כרטיסייה 10 כניסות · נשארו 2 מתוך 10", entity_type: "contact", entity_id: c },
    ]);
    expect(JSON.stringify(got)).not.toContain("נועה");
    await use(id, 1);
    await run();
    expect(await notices(c)).toHaveLength(1);
    expect(await sent(id)).toEqual(["low"]);
    // used up: nothing more (a used up card is "נוצלה")
    await use(id, 1);
    await run();
    expect(await notices(c)).toHaveLength(1);
  });

  it("owner (139) ב: 0 left counts as few left, once, with the whole phrase (138)", async () => {
    const c = await contact(rep.id);
    const id = await card(c, product10, 30, null);
    await run();
    expect(await notices(c)).toEqual([]);
    await use(id, 10);
    await run();
    expect((await notices(c)).map((n) => [n.title, n.body])).toEqual([["כרטיסייה: לא נשארו כניסות", "כרטיסייה 10 כניסות · נשארו 0 מתוך 10"]]);
    await run();
    expect(await notices(c)).toHaveLength(1);
  });

  it("owner (138) ב: the {כניסות} phrase in SQL equals the shared fixture", async () => {
    const fixture = JSON.parse(readFileSync("tests/unit/fixtures/punch-card-entries.json", "utf8")) as Array<{ left: number; text: string }>;
    for (const c of fixture) {
      expect(await asAdmin(async (q) => (await one<{ t: string }>(q, "select app.punch_card_entries_text($1) as t", [c.left])).t), String(c.left)).toBe(c.text);
    }
  });

  it("owner (140) ב: the state at release alerts nobody; a card that crosses afterwards does; a regained key starts afresh", async () => {
    const otherOwner = await createUser("pa-release");
    const other = await createOrg(otherOwner.id, "עסק שעולה לאוויר");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [other, zone]));
    const otherType = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meeting_types where organization_id = $1 order by position, created_at, id limit 1", [other])).id);
    const product = (entries: number) =>
      asUser(otherOwner.id, async (q) =>
        (
          await one<{ id: string }>(
            q,
            `insert into public.products (organization_id, name, kind, price_agorot, vat_kind, price_includes_vat, punch_entries, punch_validity_count, punch_validity_unit, punch_meeting_type_ids)
             values ($1, $2, 'punch_card', 10000, 'taxable', true, $3, 3, 'months', $4) returning id`,
            [other, `כרטיסייה ${entries}`, entries, [otherType]],
          )
        ).id,
      );
    const p2 = await product(2);
    const p10 = await product(10);
    const otherContact = await asAdmin(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, owner_id) values ($1, 'x', $2) returning id", [other, otherOwner.id])).id);
    const open = async (productId: string, activatedDaysAgo: number, expiresInDays: number | null) => {
      const id = await asUser(otherOwner.id, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [other, otherContact, productId])).id);
      await asAdmin((q) =>
        q(
          "update public.punch_cards set activated_at = now() - make_interval(days => $2), expires_on = case when $3::int is null then null else (now() at time zone $4)::date + $3::int end where id = $1",
          [id, activatedDaysAgo, expiresInDays, zone],
        ),
      );
      return id;
    };
    const otherNotices = () =>
      asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.notifications where organization_id = $1 and type = 'punch_card'", [other])).n);
    const marked = (id: string) =>
      asAdmin(async (q) => (await q<{ kind: string }>("select kind from app.punch_card_alerts_sent where card_id = $1 and baseline order by kind", [id])).rows.map((r) => r.kind));
    const runOther = () => asAdmin((q) => q("select app.send_punch_card_alerts($1)", [[other]]));
    // cards in an alert state before the job ever saw the business
    const low = await open(p2, 0, null);
    const near = await open(p10, 60, 5);
    const later = await open(p10, 60, null);
    await runOther();
    expect(await otherNotices()).toBe(0);
    expect(await marked(low)).toEqual(["low"]);
    expect(await marked(near)).toEqual(["expiry"]);
    // a card that crosses afterwards alerts
    await asAdmin((q) => q("insert into public.punch_card_uses (organization_id, card_id, used_on) select $1, $2, current_date from generate_series(1, 8)", [other, later]));
    await runOther();
    expect(await otherNotices()).toBe(1);
    // the key lost, a card crosses meanwhile, the key regained: that card is marked, not alerted
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify({ ...FEATURES, punch_cards: false })]));
    await runOther();
    expect(await asAdmin(async (q) => (await one<{ a: boolean }>(q, "select active as a from app.punch_card_alert_orgs where organization_id = $1", [other])).a)).toBe(false);
    // the card is opened by hand while the plan lacks the key: written as the server would (the key is asked by punch_card_open)
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify(FEATURES)]));
    const meanwhile = await open(p2, 0, null);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify({ ...FEATURES, punch_cards: false })]));
    await runOther();
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify(FEATURES)]));
    await runOther();
    expect(await otherNotices()).toBe(1);
    expect(await marked(meanwhile)).toEqual(["low"]);
  });

  it("a card never used with entries at or under the number alerts at once", async () => {
    const c = await contact(rep.id);
    const id = await card(c, product2, 0, null);
    await run();
    expect((await notices(c)).map((n) => n.title)).toEqual(["כרטיסייה: נשארו 2 כניסות"]);
    expect(await sent(id)).toEqual(["low"]);
  });

  it("the last day near: a card opened before the window alerts, one opened inside it does not, an expired one never", async () => {
    const c = await contact(rep.id);
    // activated 60 days ago, last day in 10 days: alerts (never used, but 10 entries: no few-left alert)
    const before = await card(c, product10, 60, 10);
    // activated 2 days ago, last day in 10 days: opened inside the 14-day window, no alert (owner (131))
    const inside = await card(c, product10, 2, 10);
    // expired yesterday: nothing
    await card(c, product10, 90, -1);
    // last day in 20 days: outside the window
    const later = await card(c, product10, 60, 20);
    await run();
    const got = await notices(c);
    expect(got.map((n) => [n.title, n.body])).toEqual([
      ["כרטיסייה: התוקף מסתיים בעוד 10 ימים", expect.stringMatching(/^כרטיסייה 10 כניסות · נשארו 10 מתוך 10 · בתוקף עד \d{2}\.\d{2}\.\d{4}$/)],
    ]);
    expect(await sent(before)).toEqual(["expiry"]);
    expect(await sent(inside)).toEqual([]);
    expect(await sent(later)).toEqual([]);
    // review finding 4: the business widens the window: what the new number reaches at once is marked, not alerted
    const before20 = (await notices(c)).length;
    await asUser(owner.id, (q) => q("insert into public.punch_card_alert_settings (organization_id, expiry_days) values ($1, 30)", [org]));
    await run();
    expect(await sent(later)).toEqual([]);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from app.punch_card_alerts_sent where card_id = $1 and baseline", [later])).n)).toBe(1);
    expect(await notices(c)).toHaveLength(before20);
    expect(await sent(inside)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.punch_card_alert_settings set expiry_days = 14 where organization_id = $1", [org]));
  });

  it("the last day today and tomorrow are said in words", async () => {
    const c = await contact(rep.id);
    await card(c, product10, 60, 0);
    await card(c, product10, 60, 1);
    await run();
    expect((await notices(c)).map((n) => n.title).sort()).toEqual(["כרטיסייה: התוקף מסתיים היום", "כרטיסייה: התוקף מסתיים מחר"].sort());
  });

  it("the business's numbers: a larger few-left number, and 0 switches an alert off", async () => {
    await asUser(owner.id, (q) => q("update public.punch_card_alert_settings set low_entries = 0, expiry_days = 0 where organization_id = $1", [org]));
    const c = await contact(rep.id);
    const id = await card(c, product2, 60, 3);
    await run();
    expect(await notices(c)).toEqual([]);
    // review finding 4: a larger number (from 0 too) marks what it reaches at once; a card that crosses it later alerts
    await asUser(owner.id, (q) => q("update public.punch_card_alert_settings set low_entries = 5 where organization_id = $1", [org]));
    await run();
    expect(await sent(id)).toEqual([]);
    expect(await notices(c)).toEqual([]);
    const crosses = await card(c, product10, 60, null);
    await use(crosses, 4);
    await run();
    expect(await sent(crosses)).toEqual([]);
    await use(crosses, 1);
    await run();
    expect(await sent(crosses)).toEqual(["low"]);
    expect((await notices(c)).map((n) => n.title)).toEqual(["כרטיסייה: נשארו 5 כניסות"]);
    // back to the defaults: the expiry the card already meets is marked too, never sent
    await asUser(owner.id, (q) => q("update public.punch_card_alert_settings set low_entries = 2, expiry_days = 14 where organization_id = $1", [org]));
    await run();
    expect(await sent(id)).toEqual([]);
    expect(await notices(c)).toHaveLength(1);
  });

  it("re-review finding 1: a save marks only what the new numbers reach and the old ones did not", async () => {
    const c = await contact(rep.id);
    // already due under the defaults (2 left) and not yet alerted: still alerted after a save of other numbers
    const due = await card(c, product2, 0, null);
    // 4 left: reached only by the new few-left number 5
    const reached = await card(c, product10, 0, null);
    await use(reached, 6);
    const upsert = (fields: string, values: unknown[]) =>
      asUser(owner.id, async (q) => {
        const updated = await q(`update public.punch_card_alert_settings set ${fields} where organization_id = $1`, [org, ...values]);
        if (updated.rowCount === 0) throw new Error("no settings row");
      });
    // a save that changes only customer messages marks nothing
    await upsert("customer_messages = true", []);
    await upsert("customer_messages = false", []);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from app.punch_card_alerts_sent where card_id = any($1) and baseline", [[due, reached]])).n)).toBe(0);
    await upsert("low_entries = $2", [5]);
    await run();
    expect(await sent(due)).toEqual(["low"]);
    expect(await sent(reached)).toEqual([]);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from app.punch_card_alerts_sent where card_id = $1 and baseline", [reached])).n)).toBe(1);
    await upsert("low_entries = $2", [2]);
  });

  it("re-review finding 1: a first save holding the defaults marks nothing", async () => {
    const otherOwner = await createUser("pa-defaults");
    const other = await createOrg(otherOwner.id, "עסק ברירת מחדל");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify(FEATURES)]));
    await asAdmin((q) => q("insert into app.punch_card_alert_orgs (organization_id) values ($1)", [other]));
    const t = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meeting_types where organization_id = $1 limit 1", [other])).id);
    const p = await asUser(otherOwner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.products (organization_id, name, kind, price_agorot, vat_kind, price_includes_vat, punch_entries, punch_meeting_type_ids)
           values ($1, 'שתיים', 'punch_card', 100, 'taxable', true, 2, $2) returning id`,
          [other, [t]],
        )
      ).id,
    );
    const cc = await asAdmin(async (q) => (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name) values ($1, 'x') returning id", [other])).id);
    const id = await asUser(otherOwner.id, async (q) => (await one<{ id: string }>(q, "select public.punch_card_open($1, $2, $3, null, true) as id", [other, cc, p])).id);
    await asUser(otherOwner.id, (q) => q("insert into public.punch_card_alert_settings (organization_id, low_entries, expiry_days) values ($1, 2, 14)", [other]));
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from app.punch_card_alerts_sent where card_id = $1", [id])).n)).toBe(0);
  });

  it("review finding 4: a baseline also marks a card whose contact is in the bin, so a restore is no burst", async () => {
    const c = await contact(rep.id);
    const id = await card(c, product10, 60, null);
    await use(id, 7);
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [c]));
    await asUser(owner.id, (q) => q("update public.punch_card_alert_settings set low_entries = 3 where organization_id = $1", [org]));
    await asAdmin((q) => q("update public.contacts set deleted_at = null where id = $1", [c]));
    await run();
    expect(await notices(c)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.punch_card_alert_settings set low_entries = 2 where organization_id = $1", [org]));
  });

  it("no usable owner: every active owner and admin gets it", async () => {
    const none = await contact(null);
    const byViewer = await contact(viewer.id);
    await card(none, product2, 0, null);
    await card(byViewer, product2, 0, null);
    await run();
    const expected = [admin.id, owner.id].sort();
    expect((await notices(none)).map((n) => n.user_id).sort()).toEqual(expected);
    expect((await notices(byViewer)).map((n) => n.user_id).sort()).toEqual(expected);
  });

  it("the kind can be muted (owner (132) ב)", async () => {
    await asUser(rep.id, (q) => q("select public.set_notification_settings($1::text[], $2::text[])", ["{punch_card}", "{}"]));
    try {
      const c = await contact(rep.id);
      const id = await card(c, product2, 0, null);
      await run();
      expect(await notices(c)).toEqual([]);
      // the alert counts as sent: muting is the person's choice, not a failure to retry
      expect(await sent(id)).toEqual(["low"]);
    } finally {
      await asUser(rep.id, (q) => q("select public.set_notification_settings($1::text[], $2::text[])", ["{}", "{}"]));
    }
  });

  it("nothing for a business without the key, one not writable, a cancelled card or a contact in the bin", async () => {
    const c = await contact(rep.id);
    const id = await card(c, product2, 0, null);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ ...FEATURES, punch_cards: false })]));
    await run();
    expect(await sent(id)).toEqual([]);
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
    const status = await asAdmin(async (q) => (await one<{ status: string }>(q, "select status from public.organizations where id = $1", [org])).status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      await run();
      expect(await sent(id)).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [c]));
    await run();
    expect(await sent(id)).toEqual([]);
    await asAdmin((q) => q("update public.contacts set deleted_at = null where id = $1", [c]));
    await asUser(owner.id, (q) => q("select public.punch_card_cancel($1, $2, 'טעות')", [org, id]));
    await run();
    expect(await sent(id)).toEqual([]);
  });

  it("before 08:00 in the business's zone nothing is sent", async () => {
    const early = await asAdmin(async (q) =>
      (
        await one<{ z: string | null }>(
          q,
          `select z from unnest(array['Asia/Jerusalem', 'Asia/Tokyo', 'Pacific/Kiritimati', 'America/New_York', 'America/Los_Angeles', 'Europe/London', 'Asia/Kolkata', 'Pacific/Honolulu', 'Pacific/Auckland', 'Asia/Dubai']) z
            where extract(hour from now() at time zone z) < 8 limit 1`,
        )
      )?.z ?? null,
    );
    if (early === null) return;
    await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, early]));
    try {
      const c = await contact(rep.id);
      const id = await card(c, product2, 0, null);
      await run();
      expect(await sent(id)).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
    }
  });

  it("fair and bounded: the per-business cap holds, and a failing card is counted, retried, then skipped after 3", async () => {
    // cards left over from earlier tests (one made before 08:00 in another zone, say) are sent first
    await run();
    const c = await contact(rep.id);
    const a = await card(c, product2, 0, null);
    const b = await card(c, product2, 0, null);
    await asAdmin(async (q) => {
      await q("select set_config('app.punch_card_alert_per_org', '1', true)");
      await q("select app.send_punch_card_alerts($1)", [[org]]);
    });
    expect([...(await sent(a)), ...(await sent(b))]).toEqual(["low"]);
    await run();
    expect([...(await sent(a)), ...(await sent(b))]).toEqual(["low", "low"]);

    // a card whose notice cannot be written: a check that refuses this one card's title
    const c2 = await contact(rep.id);
    const bad = await card(c2, product2, 0, null);
    await asAdmin((q) =>
      q(`alter table public.notifications add constraint test_297_refuse check (entity_id is distinct from '${c2}'::uuid or type <> 'punch_card' or title <> 'כרטיסייה: נשארו 2 כניסות' or created_at < '2000-01-01')`),
    );
    try {
      for (let i = 0; i < 4; i++) await run();
    } finally {
      await asAdmin((q) => q("alter table public.notifications drop constraint test_297_refuse"));
    }
    const row = await asAdmin(async (q) => (await one<{ failures: number; done_at: string | null }>(q, "select failures, done_at from app.punch_card_alerts_sent where card_id = $1 and kind = 'low'", [bad])));
    expect(row).toEqual({ failures: 3, done_at: null });
    // skipped for good
    await run();
    expect(await sent(bad)).toEqual([]);
  });

  it("is scheduled every 15 minutes and callable by nobody", async () => {
    const grants = await asAdmin(async (q) =>
      (
        await one<{ a: boolean; s: boolean }>(
          q,
          "select has_function_privilege('authenticated', 'app.send_punch_card_alerts(uuid[])', 'execute') as a, has_function_privilege('service_role', 'app.send_punch_card_alerts(uuid[])', 'execute') as s",
        )
      ),
    );
    expect(grants).toEqual({ a: false, s: false });
    const job = await asAdmin(async (q) => {
      const cron = await one<{ n: number }>(q, "select count(*)::int as n from pg_extension where extname = 'pg_cron'");
      if (cron.n === 0) return null;
      return one<{ schedule: string }>(q, "select schedule from cron.job where jobname = 'crm-punch-card-alerts'");
    });
    if (job !== null) expect(job).toEqual({ schedule: "*/15 * * * *" });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Job = { payload: Record<string, unknown> };

/**
 * PKG-03 (customer side, owner (127)-(129)): a service message type punch_card_notice with its closed merge fields, two
 * seeded DRAFT templates (one per alert, server-only mark notice_kind), and, while the business switched customer
 * messages on, one message.send queued beside the rep's alert: the contact's preferred channel first, then SMS, WhatsApp,
 * email, only with an address and an active template of that channel. A template that cannot be sent queues nothing and
 * tells the owners and admins.
 */
describe("punch card notices to the customer (PKG-03)", () => {
  let owner: U, admin: U, rep: U;
  let org: string;
  let typeA: string;
  let product2: string, product10: string;
  let zone: string;
  const FEATURES = { products: true, payments: true, punch_cards: true };

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select app.send_punch_card_alerts($1) as n", [[org]])).n);
  const contact = (fields: { phone?: string | null; email?: string | null; preferred?: string | null }) =>
    asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.contacts (organization_id, first_name, owner_id, phone, email, preferred_channel) values ($1, 'דנה', $2, $3, $4, $5) returning id",
          [org, rep.id, fields.phone ?? null, fields.email ?? null, fields.preferred ?? null],
        )
      ).id,
    );
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
  const card = async (contactId: string, product: string, activatedDaysAgo = 0, expiresInDays: number | null = null) => {
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
  const use = (cardId: string, n = 1) =>
    asAdmin((q) => q("insert into public.punch_card_uses (organization_id, card_id, used_on) select $1, $2, current_date from generate_series(1, $3)", [org, cardId, n]));
  const endOfDay = (event: unknown, daysFromToday: number) =>
    asAdmin(async (q) =>
      (await one<{ ok: boolean }>(q, "select ($1::timestamptz = (((now() at time zone $2)::date + $3::int + 1)::timestamp at time zone $2)) as ok", [event, zone, daysFromToday])).ok,
    );
  const jobs = (contactId: string) =>
    asAdmin(async (q) =>
      (await q<Job>("select payload from app.jobs where organization_id = $1 and payload ->> 'contact_id' = $2 order by created_at, id", [org, contactId])).rows.map((r) => r.payload),
    );
  // the seeded notice of a mark on one channel (SMS: the channel every phone-only contact here gets). "the channel" test adds
  // WhatsApp and email copies of the few-left notice under the same mark, so a lookup by the mark alone answered whichever
  // copy the plan met first (seen in full runs, never alone)
  const template = (kind: string, channel = "sms") =>
    asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "select id from public.message_templates where organization_id = $1 and notice_kind = $2 and channel = $3 order by created_at, id limit 1",
          [org, kind, channel],
        )
      ).id,
    );
  const setCustomerMessages = (on: boolean) =>
    asUser(owner.id, async (q) => {
      const updated = await q("update public.punch_card_alert_settings set customer_messages = $2 where organization_id = $1", [org, on]);
      if (updated.rowCount === 0) await q("insert into public.punch_card_alert_settings (organization_id, customer_messages) values ($1, $2)", [org, on]);
    });

  beforeAll(async () => {
    owner = await createUser("pn-owner");
    org = await createOrg(owner.id, "סטודיו ההודעות");
    admin = await addMember(org, owner.id, "admin", "pn-admin");
    rep = await addMember(org, owner.id, "member", "pn-member");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify(FEATURES)]));
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
    product2 = await punchProduct("כרטיסייה קטנה", 2);
    product10 = await punchProduct("כרטיסייה גדולה", 10);
    // (140)/(141) the job's first look at the business (with the key) seeds its two notices and starts its alerts
    await run();
  });

  it("punch_card_notice is a service type with a closed list of fields, and the template check knows it", async () => {
    const lists = await asAdmin(async (q) =>
      one<{ all: string[]; service: string[]; fields: string[]; merge: string[] }>(
        q,
        "select app.message_types() as all, app.service_message_types() as service, app.message_type_fields('punch_card_notice') as fields, app.message_merge_fields() as merge",
      ),
    );
    expect(lists.all).toContain("punch_card_notice");
    expect(lists.service).toContain("punch_card_notice");
    expect(lists.fields).toEqual(["שם פרטי", "שם העסק", "טלפון העסק", "שם הכרטיסייה", "כניסות", "תאריך"]);
    expect(lists.merge).toEqual(expect.arrayContaining(["שם הכרטיסייה", "כניסות"]));
    // no price, link or offer: a field outside the list is "field_not_allowed"
    const problems = await asAdmin(async (q) =>
      one<{ amount: string | null; ok: string | null }>(
        q,
        `select app.message_template_problem('sms', 'punch_card_notice', null, 'נשארו {כניסות} ב-{סכום}', null, null) as amount,
                app.message_template_problem('sms', 'punch_card_notice', null, 'שלום {שם פרטי}, {שם הכרטיסייה}: {כניסות}, עד {תאריך}. {טלפון העסק} {שם העסק}', null, null) as ok`,
      ),
    );
    expect(problems).toEqual({ amount: "field_not_allowed", ok: null });
    // a person may save a template of the type
    await asUser(owner.id, (q) =>
      q("insert into public.message_templates (organization_id, name, channel, message_type, body) values ($1, 'כרטיסייה ידנית', 'whatsapp', 'punch_card_notice', 'שלום {שם פרטי}')", [org]),
    );
  });

  it("owner (141) ב: the notices come only with the key, also on an upgrade, and only while the business has none", async () => {
    const otherOwner = await createUser("pn-upgrade");
    const other = await createOrg(otherOwner.id, "עסק בלי כרטיסיות");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify({ punch_cards: false })]));
    const marks = () =>
      asAdmin(async (q) => (await q<{ k: string }>("select notice_kind as k from public.message_templates where organization_id = $1 and notice_kind is not null order by 1", [other])).rows.map((r) => r.k));
    const runOther = () => asAdmin((q) => q("select app.send_punch_card_alerts($1)", [[other]]));
    // 021177's one-off backfill may have given it the two; the rule from here on is (141)
    await asAdmin((q) => q("update public.message_templates set notice_kind = null where organization_id = $1", [other]));
    await runOther();
    await asAdmin((q) => q("select app.seed_punch_card_message_templates($1)", [other]));
    expect(await marks()).toEqual([]);
    // the upgrade: the job sees the key and seeds them (names taken by the unmarked old copies are kept, so rename those)
    await asAdmin((q) => q("update public.message_templates set name = name || ' (ישן)' where organization_id = $1 and name like 'כרטיסייה:%'", [other]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify({ punch_cards: true })]));
    await runOther();
    expect(await marks()).toEqual(["punch_card_expiry", "punch_card_low"]);
    // one of them deleted, the key lost and regained: none is added back while the other is there
    await asUser(otherOwner.id, (q) => q("delete from public.message_templates where organization_id = $1 and notice_kind = 'punch_card_low'", [other]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify({ punch_cards: false })]));
    await runOther();
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [other, JSON.stringify({ punch_cards: true })]));
    await runOther();
    expect(await marks()).toEqual(["punch_card_expiry"]);
  });

  it("a new business starts with the two DRAFT notices, sendable as they are; the mark is the server's", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ name: string; channel: string; message_type: string; notice_kind: string; ok: string | null }>(
          "select name, channel, message_type, notice_kind, app.message_template_sendable(organization_id, id) as ok from public.message_templates where organization_id = $1 and notice_kind is not null order by notice_kind desc",
          [org],
        )
      ).rows,
    );
    expect(rows).toEqual([
      { name: "כרטיסייה: נשארו מעט כניסות", channel: "sms", message_type: "punch_card_notice", notice_kind: "punch_card_low", ok: null },
      { name: "כרטיסייה: התוקף מתקרב", channel: "sms", message_type: "punch_card_notice", notice_kind: "punch_card_expiry", ok: null },
    ]);
    // and the four general templates are still there
    const all = await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.message_templates where organization_id = $1 and notice_kind is null and name <> 'כרטיסייה ידנית'", [org])).n);
    expect(all).toBe(4);
    const low = await template("punch_card_low");
    expect((await pgError(asUser(owner.id, (q) => q("update public.message_templates set notice_kind = null where id = $1", [low])))).code).toBe("42501");
    expect(
      (await pgError(asUser(owner.id, (q) => q("insert into public.message_templates (organization_id, name, channel, message_type, body, notice_kind) values ($1, 'x', 'sms', 'punch_card_notice', 'y', 'punch_card_low')", [org])))).code,
    ).toBe("42501");
    // seeding again adds nothing
    await asAdmin((q) => q("select app.seed_punch_card_message_templates($1)", [org]));
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.message_templates where organization_id = $1 and notice_kind is not null", [org])).n)).toBe(2);
  });

  it("customer messages are off by default: the rep is told, the customer is sent nothing", async () => {
    const c = await contact({ phone: "0501234567" });
    await card(c, product2);
    await run();
    expect(await jobs(c)).toEqual([]);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.notifications where type = 'punch_card' and entity_id = $1", [c])).n)).toBe(1);
  });

  it("on: one service message on SMS with the template and the card, the expiry one ending with the card's last day", async () => {
    await setCustomerMessages(true);
    const c = await contact({ phone: "0501234567" });
    const low = await card(c, product10);
    await use(low, 8);
    const expiring = await card(c, product10, 60, 5);
    await run();
    const got = await jobs(c);
    expect(got).toHaveLength(2);
    const lowJob = got.find((j) => j.punch_card_id === low);
    expect(lowJob).toMatchObject({ channel: "sms", contact_id: c, message_type: "punch_card_notice", template_id: await template("punch_card_low"), punch_card_id: low });
    // review finding 1: a card with no expiry: the message ends with the day 7 days from today
    expect(await endOfDay(lowJob?.event_at, 7)).toBe(true);
    const expiryJob = got.find((j) => j.punch_card_id === expiring);
    expect(expiryJob).toMatchObject({ channel: "sms", contact_id: c, message_type: "punch_card_notice", template_id: await template("punch_card_expiry"), punch_card_id: expiring });
    const ends = await asAdmin(async (q) =>
      one<{ ok: boolean }>(q, "select ($1::timestamptz = (((now() at time zone $2)::date + 6)::timestamp at time zone $2)) as ok", [expiryJob?.event_at, zone]),
    );
    expect(ends.ok).toBe(true);
    // the customer's side keeps the job
    const kept = await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from app.punch_card_customer_notices where card_id = any($1) and job_id is not null and done_at is not null", [[low, expiring]])).n);
    expect(kept).toBe(2);
    // judged as a service message at send time (the closed service list)
    expect(await asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select 'punch_card_notice' = any (app.service_message_types()) as ok")).ok)).toBe(true);
  });

  it("the channel: the preferred one when it has an address and a template, else SMS, WhatsApp, email", async () => {
    // the low notice gets a WhatsApp copy and an email copy (the server's mark, as a migration would)
    const low = await template("punch_card_low");
    await asAdmin((q) =>
      q(
        `insert into public.message_templates (organization_id, name, channel, message_type, subject, body, notice_kind)
         select organization_id, name || ' ' || ch, ch, message_type, case when ch = 'email' then 'כרטיסייה' end, body, notice_kind
           from public.message_templates, unnest(array['whatsapp', 'email']) ch where id = $1`,
        [low],
      ),
    );
    const prefersEmail = await contact({ phone: "0501234567", email: "dana@example.test", preferred: "email" });
    const prefersWa = await contact({ phone: "0501234567", preferred: "whatsapp" });
    const prefersEmailNoAddress = await contact({ phone: "0501234567", preferred: "email" });
    const emailOnly = await contact({ email: "only@example.test" });
    const phonePreferred = await contact({ phone: "0501234567", preferred: "phone" });
    const nothing = await contact({});
    for (const c of [prefersEmail, prefersWa, prefersEmailNoAddress, emailOnly, phonePreferred, nothing]) await use(await card(c, product2));
    await run();
    const channel = async (c: string) => (await jobs(c)).map((j) => j.channel);
    expect(await channel(prefersEmail)).toEqual(["email"]);
    expect(await channel(prefersWa)).toEqual(["whatsapp"]);
    expect(await channel(prefersEmailNoAddress)).toEqual(["sms"]);
    expect(await channel(emailOnly)).toEqual(["email"]);
    expect(await channel(phonePreferred)).toEqual(["sms"]);
    expect(await channel(nothing)).toEqual([]);
  });

  it("review findings 2, 3, 6: a never-used card tells the rep only; both alerts = one message; a phone the system cannot read is no SMS address", async () => {
    const fresh = await contact({ phone: "0501234567" });
    const freshCard = await card(fresh, product2);
    await run();
    expect(await jobs(fresh)).toEqual([]);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.notifications where type = 'punch_card' and entity_id = $1", [fresh])).n)).toBe(1);
    // owner (148) ב: the first use that leaves it at or under the number sends the customer's message, once
    await use(freshCard);
    await run();
    expect((await jobs(fresh)).map((j) => j.punch_card_id)).toEqual([freshCard]);
    await use(freshCard);
    await run();
    expect(await jobs(fresh)).toHaveLength(1);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.notifications where type = 'punch_card' and entity_id = $1", [fresh])).n)).toBe(1);

    const both = await contact({ phone: "0501234567" });
    const id = await card(both, product10, 60, 5);
    await use(id, 8);
    await run();
    const got = await jobs(both);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ template_id: await template("punch_card_expiry"), punch_card_id: id });
    expect(await endOfDay(got[0].event_at, 5)).toBe(true);
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.notifications where type = 'punch_card' and entity_id = $1", [both])).n)).toBe(2);

    const unreadable = await contact({ phone: "אין" });
    expect(await asAdmin(async (q) => (await one<{ e: string | null }>(q, "select phone_e164 as e from public.contacts where id = $1", [unreadable])).e)).toBeNull();
    await use(await card(unreadable, product2));
    await run();
    expect(await jobs(unreadable)).toEqual([]);
  });

  it("review finding 5: near the 50-template cap the seed adds what fits and tries the other again later", async () => {
    const capOwner = await createUser("pn-cap");
    const capOrg = await createOrg(capOwner.id, "עסק מלא תבניות");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [capOrg, JSON.stringify({ punch_cards: false })]));
    await asAdmin((q) => q("update public.message_templates set notice_kind = null, name = name || ' (ישן)' where organization_id = $1 and notice_kind is not null", [capOrg]));
    const count = () => asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.message_templates where organization_id = $1", [capOrg])).n);
    const have = await count();
    await asAdmin((q) =>
      q(
        "insert into public.message_templates (organization_id, name, channel, message_type, body) select $1, 'תבנית ' || g, 'sms', 'marketing', 'שלום' from generate_series(1, 49 - $2::int) g",
        [capOrg, have],
      ),
    );
    expect(await count()).toBe(49);
    const marks = () =>
      asAdmin(async (q) => (await q<{ k: string }>("select notice_kind as k from public.message_templates where organization_id = $1 and notice_kind is not null order by 1", [capOrg])).rows.map((r) => r.k));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [capOrg, JSON.stringify({ punch_cards: true })]));
    await asAdmin((q) => q("select app.send_punch_card_alerts($1)", [[capOrg]]));
    expect(await marks()).toEqual(["punch_card_low"]);
    // room again: tried at most once a day (re-review finding 4), so the same day adds nothing; the next day adds the other
    await asUser(capOwner.id, (q) => q("delete from public.message_templates where organization_id = $1 and name = 'תבנית 1'", [capOrg]));
    await asAdmin((q) => q("select app.send_punch_card_alerts($1)", [[capOrg]]));
    expect(await marks()).toEqual(["punch_card_low"]);
    await asAdmin((q) => q("update app.punch_card_alert_orgs set seed_tried_on = current_date - 1 where organization_id = $1", [capOrg]));
    await asAdmin((q) => q("select app.send_punch_card_alerts($1)", [[capOrg]]));
    expect(await marks()).toEqual(["punch_card_expiry", "punch_card_low"]);
    // a seeded one the business deletes is not brought back while the other one is there
    await asUser(capOwner.id, (q) => q("delete from public.message_templates where organization_id = $1 and notice_kind = 'punch_card_low'", [capOrg]));
    await asAdmin((q) => q("select app.send_punch_card_alerts($1)", [[capOrg]]));
    expect(await marks()).toEqual(["punch_card_expiry"]);
  });

  it("re-review finding 3: an expiry message given up lets the few-left one go", async () => {
    const c = await contact({ phone: "0501234567" });
    const id = await card(c, product10, 60, 5);
    await use(id, 8);
    // the rep's alerts first, while customer messages are off; then the customer's side as the job would have left it
    await setCustomerMessages(false);
    await run();
    await setCustomerMessages(true);
    await asAdmin((q) =>
      q("insert into app.punch_card_customer_notices (organization_id, card_id, kind, failures) values ($1, $2, 'expiry', 3), ($1, $2, 'low', 0)", [org, id]),
    );
    await run();
    const got = await jobs(c);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ template_id: await template("punch_card_low"), punch_card_id: id });
  });

  it("customer messages switched on later bring no burst: only alerts made while they were on wait", async () => {
    await setCustomerMessages(false);
    const c = await contact({ phone: "0501234567" });
    const id = await card(c, product2);
    await use(id);
    await run();
    await setCustomerMessages(true);
    await run();
    expect(await jobs(c)).toEqual([]);
  });

  const waiting = (cardId: string) =>
    asAdmin(async (q) =>
      (
        await q<{ kind: string; done: boolean; reason: string | null; covered: boolean }>(
          "select kind, done_at is not null as done, closed_reason as reason, covered from app.punch_card_customer_notices where card_id = $1 order by kind",
          [cardId],
        )
      ).rows,
    );

  it("last review 1: the expiry message covers a few-left one only while that one is due; one waiting for its first use goes later", async () => {
    await setCustomerMessages(true);
    const c = await contact({ phone: "0501234567" });
    // 2 entries, never used, last day in 5 days, opened long before: both alerts for the rep, both rows wait
    const id = await card(c, product2, 60, 5);
    await run();
    expect((await jobs(c)).map((j) => j.template_id)).toEqual([await template("punch_card_expiry")]);
    expect(await waiting(id)).toEqual([
      { kind: "expiry", done: true, reason: null, covered: false },
      { kind: "low", done: false, reason: null, covered: false },
    ]);
    await use(id);
    await run();
    const got = await jobs(c);
    expect(got.map((j) => j.template_id)).toEqual([await template("punch_card_expiry"), await template("punch_card_low")]);
    // last review 2: the few-left message ends with the card's last day when it comes before today + 7
    expect(await endOfDay(got[1].event_at, 5)).toBe(true);
  });

  it("last review 2: a few-left message ends at today + 7 when the last day is later", async () => {
    await setCustomerMessages(true);
    const c = await contact({ phone: "0501234567" });
    const id = await card(c, product2, 0, 40);
    await use(id);
    await run();
    const got = await jobs(c);
    expect(got).toHaveLength(1);
    expect(await endOfDay(got[0].event_at, 7)).toBe(true);
  });

  it("last review 3: waiting rows that can never be sent are closed with a reason, and switching back on brings no burst", async () => {
    await setCustomerMessages(true);
    const open = async () => {
      const c = await contact({ phone: "0501234567" });
      const id = await card(c, product2);
      return { c, id };
    };
    const cancelled = await open();
    const expired = await open();
    const binned = await open();
    const off = await open();
    // the rep's alerts; the customer's rows wait for a first use
    await run();
    for (const x of [cancelled, expired, binned, off]) expect((await waiting(x.id)).map((w) => w.done)).toEqual([false]);
    await asUser(owner.id, (q) => q("select public.punch_card_cancel($1, $2, 'טעות')", [org, cancelled.id]));
    await asAdmin((q) => q("update public.punch_cards set expires_on = (now() at time zone $2)::date - 1 where id = $1", [expired.id, zone]));
    await asAdmin((q) => q("update public.contacts set deleted_at = now() where id = $1", [binned.c]));
    await run();
    expect(await waiting(cancelled.id)).toEqual([{ kind: "low", done: true, reason: "card_inactive", covered: false }]);
    expect(await waiting(expired.id)).toEqual([{ kind: "low", done: true, reason: "card_expired", covered: false }]);
    expect(await waiting(binned.id)).toEqual([{ kind: "low", done: true, reason: "contact_gone", covered: false }]);
    expect(await waiting(off.id)).toEqual([{ kind: "low", done: false, reason: null, covered: false }]);
    // switched off while waiting: closed; on again and used: nothing goes
    await setCustomerMessages(false);
    await run();
    expect(await waiting(off.id)).toEqual([{ kind: "low", done: true, reason: "messages_off", covered: false }]);
    await setCustomerMessages(true);
    await use(off.id);
    await run();
    for (const x of [cancelled, expired, binned, off]) expect(await jobs(x.c)).toEqual([]);
    await asAdmin((q) => q("update public.contacts set deleted_at = null where id = $1", [binned.c]));
  });

  it("a switched-off template sends nothing; one that cannot be sent tells the owners and admins and queues nothing", async () => {
    const expiry = await template("punch_card_expiry");
    await asUser(owner.id, (q) => q("update public.message_templates set is_active = false where id = $1", [expiry]));
    const a = await contact({ phone: "0501234567" });
    await card(a, product10, 60, 5);
    await run();
    expect(await jobs(a)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.message_templates set is_active = true, body = body || ' {סכום}' where id = $1", [expiry]));
    const b = await contact({ phone: "0501234567" });
    await card(b, product10, 60, 5);
    await run();
    expect(await jobs(b)).toEqual([]);
    const told = await asAdmin(async (q) =>
      (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and type = 'system' and title = 'הודעה ללקוח לא נשלחה' and entity_id = $2 order by user_id", [org, expiry])).rows.map((r) => r.user_id),
    );
    expect(told.sort()).toEqual([admin.id, owner.id].sort());
    // the rep's alert went anyway
    expect(await asAdmin(async (q) => (await one<{ n: number }>(q, "select count(*)::int as n from public.notifications where type = 'punch_card' and entity_id = $1", [b])).n)).toBe(1);
    await asUser(owner.id, (q) => q("update public.message_templates set body = replace(body, ' {סכום}', '') where id = $1", [expiry]));
  });

  it("the queue's payload takes a punch_card_id, a uuid only", async () => {
    const ok = (payload: unknown) =>
      asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify(payload)])).ok);
    const base = { channel: "sms", contact_id: "00000000-0000-4000-8000-000000000001", message_type: "punch_card_notice" };
    expect(await ok({ ...base, punch_card_id: "00000000-0000-4000-8000-000000000002" })).toBe(true);
    expect(await ok({ ...base, punch_card_id: "not-a-uuid" })).toBe(false);
    expect(await ok({ ...base, punch_card_id: 7 })).toBe(false);
  });

  it("only owners and admins switch customer messages, through the column grant", async () => {
    expect(await asUser(rep.id, async (q) => (await q("update public.punch_card_alert_settings set customer_messages = false where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await asUser(admin.id, async (q) => (await q("update public.punch_card_alert_settings set customer_messages = false where organization_id = $1", [org])).rowCount)).toBe(1);
  });
});

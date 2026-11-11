import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError, type Query } from "./helpers";

const KEY = "test-consent-key";

type U = { id: string; email: string };
type Job = { id: string; status: string; last_error: string | null; payload: Record<string, unknown>; next_run_at: Date };
type Claimed = { id: string; lease: string; organization_id: string };

/**
 * CAL-12 (owner's answers 177-182, 9 November 2026): a confirmation, a "moved" message and reminders of a meeting to its
 * customer, 24 hours and an hour before, by SMS or email, queued on the OPS-04 queue as service messages of type
 * meeting_reminder. Three switches on org_message_settings, all off by default, behind the plan key meeting_reminders.
 * Once per meeting, kind and start (app.meeting_customer_messages); a moved, cancelled, re-assigned or deleted meeting
 * cancels what still waits. 200 a business day, one confirmation per address a day. The customer confirms through the
 * personal link (booking_manage_confirm); the link a message carries is minted by meeting_reminder_link.
 */
describe("meeting messages to the customer (CAL-12)", () => {
  let owner: U, admin: U, member: U;
  let org: string;
  let other: string, otherOwner: U;
  let dana: string;

  const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
  const run = (orgs: string[] = [org]) =>
    asAdmin(async (q) => (await one<{ n: number }>(q, "select app.send_meeting_customer_reminders($1) as n", [orgs])).n);
  const contact = (orgId: string, fields: { phone?: string | null; email?: string | null; preferred?: string | null } = {}) =>
    asAdmin(async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.contacts (organization_id, first_name, phone, email, preferred_channel) values ($1, 'דנה', $2, $3, $4) returning id",
          [orgId, fields.phone === undefined ? "0501234567" : fields.phone, fields.email ?? null, fields.preferred ?? null],
        )
      ).id,
    );
  // a meeting set by the owner (the writer's transaction runs the confirmation trigger), `minutes` from now
  // (179) one confirmation per address a day: every meeting of these tests starts from a fresh day, unless it keeps the day
  const freshDay = (orgId: string) => asAdmin((q) => q("update app.meeting_confirm_buckets set day = date '2000-01-01' where organization_id = $1", [orgId]));
  const meeting = async (
    minutes: number,
    fields: { contact?: string | null; lead?: string | null; block?: boolean; orgId?: string; by?: string; keepDay?: boolean } = {},
  ) => {
    if (!fields.keepDay) await freshDay(fields.orgId ?? org);
    return asUser(fields.by ?? owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          `insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, lead_id, is_block, reminder_minutes)
           values ($1, 'פגישה', now() + make_interval(mins => $2), now() + make_interval(mins => $2 + 60), $3, $4, $5,
                   case when $5 then null else 15 end) returning id`,
          [fields.orgId ?? org, minutes, fields.block ? null : (fields.contact === undefined ? dana : fields.contact), fields.lead ?? null, fields.block ?? false],
        )
      ).id,
    );
  };
  const jobs = (meetingId: string) =>
    asAdmin(async (q) =>
      (await q<Job>("select id, status, last_error, payload, next_run_at from app.jobs where payload ->> 'meeting_id' = $1 order by created_at, id", [meetingId])).rows,
    );
  const rows = (meetingId: string) =>
    asAdmin(async (q) =>
      (await q<{ kind: string; outcome: string }>("select kind, outcome from app.meeting_customer_messages where meeting_id = $1 order by created_at, kind", [meetingId])).rows,
    );
  const template = (notice: string, channel: string, orgId = org) =>
    asAdmin(async (q) =>
      (await one<{ id: string }>(q, "select id from public.message_templates where organization_id = $1 and notice_kind = $2 and channel = $3", [orgId, notice, channel])).id,
    );
  const settings = (values: { confirm?: boolean; day?: boolean; hour?: boolean }, orgId = org, by = owner.id) =>
    asUser(by, async (q) => {
      const v = [orgId, values.confirm ?? false, values.day ?? false, values.hour ?? false];
      const updated = await q(
        "update public.org_message_settings set meeting_confirm = $2, meeting_remind_day = $3, meeting_remind_hour = $4 where organization_id = $1",
        v,
      );
      if (updated.rowCount === 0) {
        await q("insert into public.org_message_settings (organization_id, meeting_confirm, meeting_remind_day, meeting_remind_hour) values ($1, $2, $3, $4)", v);
      }
    });
  const setKey = (orgId: string, on: boolean) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1", [
        orgId,
        JSON.stringify({ meeting_reminders: on }),
      ]),
    );
  const startOf = (meetingId: string) =>
    asAdmin(async (q) => (await one<{ s: Date }>(q, "select starts_at as s from public.meetings where id = $1", [meetingId])).s);

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("cal12-owner");
    org = await createOrg(owner.id, "קליניקה לתזכורות");
    admin = await addMember(org, owner.id, "admin", "cal12-admin");
    member = await addMember(org, owner.id, "member", "cal12-member");
    otherOwner = await createUser("cal12-other");
    other = await createOrg(otherOwner.id, "עסק אחר לתזכורות");
    dana = await contact(org);
  });
  afterAll(async () => {
    // nothing of this file is left for a later file's claim
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where organization_id = any($1) and status in ('queued', 'failed', 'running')", [[org, other]]));
    await closePool();
  });

  it("the plan key: off in every plan; switching on is refused without it, switching off always passes", async () => {
    expect(await asAdmin(async (q) => (await one<{ d: boolean }>(q, "select (app.plan_key_defaults() -> 'features' ->> 'meeting_reminders')::boolean as d")).d)).toBe(false);
    // (178) ב: the plans of lead_distribution hold it, the others have it off
    const plans = await asAdmin(async (q) =>
      (
        await q<{ key: string; on: boolean | null; ld: boolean | null }>(
          "select key, (features ->> 'meeting_reminders')::boolean as on, (features ->> 'lead_distribution')::boolean as ld from public.plans order by key",
        )
      ).rows,
    );
    expect(plans.every((p) => p.on !== null)).toBe(true);
    expect(Object.fromEntries(plans.filter((p) => ["personal", "basic", "pro", "business"].includes(p.key)).map((p) => [p.key, p.on]))).toEqual({
      basic: true,
      business: true,
      personal: false,
      pro: true,
    });
    // this business without it (an override), whatever its trial plan holds
    await setKey(org, false);
    expect(await asAdmin(async (q) => (await one<{ f: boolean }>(q, "select app.org_has_feature($1, 'meeting_reminders') as f", [org])).f)).toBe(false);
    expect(await pgError(settings({ confirm: true }))).toMatchObject({ code: "P0001", hint: "feature:meeting_reminders" });
    expect(await pgError(settings({ hour: true }, org, admin.id))).toMatchObject({ hint: "feature:meeting_reminders" });
    // a server write is refused too
    expect(
      await pgError(asAdmin((q) => q("insert into public.org_message_settings (organization_id, meeting_remind_day) values ($1, true)", [org]))),
    ).toMatchObject({ hint: "feature:meeting_reminders" });
    // off (and the other columns) always pass
    await settings({});
    await asUser(owner.id, (q) => q("update public.org_message_settings set window_from = '08:00' where organization_id = $1", [org]));
    // on with the key; the key taken away: switching off still passes, on again is refused
    await setKey(org, true);
    await settings({ confirm: true });
    await setKey(org, false);
    expect(await pgError(asUser(owner.id, (q) => q("update public.org_message_settings set meeting_remind_day = true where organization_id = $1", [org])))).toMatchObject({
      hint: "feature:meeting_reminders",
    });
    // and nothing is queued at run time without the key, though the switch is still on
    const m = await meeting(60 * 48);
    expect(await jobs(m)).toEqual([]);
    await settings({});
    await setKey(org, true);
    // remove the templates the switch-on seeded: the next test starts from a business that never switched on
    await asAdmin((q) => q("update public.message_templates set notice_kind = null, name = name || ' (מבדיקה)' where organization_id = $1 and notice_kind like 'meeting%'", [org]));
  });

  it("the four DRAFT templates are seeded when a meeting message is first switched on, server-marked; the closed lists know the location", async () => {
    const marked = () =>
      asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind like 'meeting%'", [org]));
    expect(await marked()).toBe(0);
    await settings({});
    expect(await marked()).toBe(0);
    await settings({ day: true });
    expect(await marked()).toBe(8);
    await settings({});
    const seeded = await asAdmin(async (q) =>
      (
        await q<{ name: string; channel: string; message_type: string; notice_kind: string }>(
          "select name, channel, message_type, notice_kind from public.message_templates where organization_id = $1 and notice_kind like 'meeting%' order by notice_kind, channel",
          [org],
        )
      ).rows,
    );
    expect(seeded).toEqual([
      { name: "פגישה: אישור (אימייל)", channel: "email", message_type: "meeting_reminder", notice_kind: "meeting_confirm" },
      { name: "פגישה: אישור (SMS)", channel: "sms", message_type: "meeting_reminder", notice_kind: "meeting_confirm" },
      { name: "פגישה: תזכורת יום לפני (אימייל)", channel: "email", message_type: "meeting_reminder", notice_kind: "meeting_day" },
      { name: "פגישה: תזכורת יום לפני (SMS)", channel: "sms", message_type: "meeting_reminder", notice_kind: "meeting_day" },
      { name: "פגישה: תזכורת שעה לפני (אימייל)", channel: "email", message_type: "meeting_reminder", notice_kind: "meeting_hour" },
      { name: "פגישה: תזכורת שעה לפני (SMS)", channel: "sms", message_type: "meeting_reminder", notice_kind: "meeting_hour" },
      { name: "פגישה: מועד חדש (אימייל)", channel: "email", message_type: "meeting_reminder", notice_kind: "meeting_moved" },
      { name: "פגישה: מועד חדש (SMS)", channel: "sms", message_type: "meeting_reminder", notice_kind: "meeting_moved" },
    ]);
    // (182) the wording version, cleared when a person changes the text
    expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind like 'meeting%' and wording_version = 'meeting-draft-1'", [org]))).toBe(8);
    const edited = await template("meeting_moved", "email");
    await asUser(owner.id, (q) => q("update public.message_templates set subject = 'הפגישה עברה' where id = $1", [edited]));
    expect(await asAdmin(async (q) => (await one<{ v: string | null }>(q, "select wording_version as v from public.message_templates where id = $1", [edited])).v)).toBeNull();
    expect((await pgError(asUser(owner.id, (q) => q("update public.message_templates set wording_version = 'x' where id = $1", [edited])))).code).toBe("42501");
    // every seeded text passes the service rule
    expect(
      await asAdmin((q) =>
        count(
          q,
          "select 1 from public.message_templates t where t.organization_id = $1 and t.notice_kind like 'meeting%' and app.message_template_sendable(t.organization_id, t.id) is null",
          [org],
        ),
      ),
    ).toBe(8);
    // the mark is server only
    expect((await pgError(asUser(owner.id, (q) => q("update public.message_templates set notice_kind = null where organization_id = $1 and notice_kind = 'meeting_confirm'", [org])))).code).toBe("42501");
    const lists = await asAdmin(async (q) =>
      one<{ fields: string[]; merge: string[] }>(q, "select app.message_type_fields('meeting_reminder') as fields, app.message_merge_fields() as merge"),
    );
    expect(lists.fields).toEqual(expect.arrayContaining(["מיקום", "קישור"]));
    // SGN-03 adds {שם המסמך} after them
    expect(lists.merge.slice(lists.merge.indexOf("מיקום"), lists.merge.indexOf("מיקום") + 2)).toEqual(["מיקום", "קישור"]);
    // the payload takes meeting_id (a uuid) and nothing else new
    const ok = (payload: Record<string, unknown>) =>
      asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('message.send', $1) as ok", [JSON.stringify(payload)])).ok);
    const base = { channel: "sms", contact_id: dana, message_type: "meeting_reminder" };
    expect(await ok({ ...base, meeting_id: dana })).toBe(true);
    expect(await ok({ ...base, meeting_id: "x" })).toBe(false);
    expect(await ok({ ...base, meeting_title: "פגישה" })).toBe(false);
    // a deleted one is not brought back while another of the marks is there
    const sms = await template("meeting_day", "sms");
    await asUser(owner.id, (q) => q("delete from public.message_templates where id = $1", [sms]));
    await settings({ hour: true });
    await settings({});
    expect(await marked()).toBe(7);
    await asUser(owner.id, (q) =>
      q(
        "insert into public.message_templates (organization_id, name, channel, message_type, body, notice_kind) values ($1, 'x', 'sms', 'meeting_reminder', 'y', 'meeting_day')",
        [org],
      ).catch(() => undefined),
    );
    expect(await marked()).toBe(7);
    // back for the rest of this file (as the seed made it)
    await asAdmin((q) =>
      q(
        `insert into public.message_templates (organization_id, name, channel, message_type, body, notice_kind)
         values ($1, 'פגישה: תזכורת יום לפני (SMS)', 'sms', 'meeting_reminder', 'תזכורת: מחר, {תאריך} בשעה {שעה}. {שם העסק}', 'meeting_day')`,
        [org],
      ),
    );
    // PKG-03's seed still adds its own two marks beside these
    await asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb where organization_id = $1", [
        org,
        JSON.stringify({ punch_cards: true, products: true, payments: true }),
      ]),
    );
    await asAdmin((q) => q("select app.seed_punch_card_message_templates($1)", [org]));
    expect(await asAdmin((q) => count(q, "select 1 from public.message_templates where organization_id = $1 and notice_kind like 'punch_card%'", [org]))).toBe(2);
  });

  it("settings: off by default; owners and admins of the business write, members and outsiders do not", async () => {
    const m = await meeting(60 * 48);
    await run();
    expect(await jobs(m)).toEqual([]);
    expect(await rows(m)).toEqual([]);
    expect((await pgError(asUser(member.id, (q) => q("insert into public.org_message_settings (organization_id, meeting_confirm) values ($1, true)", [org])))).code).toBe("42501");
    expect((await pgError(asUser(otherOwner.id, (q) => q("insert into public.org_message_settings (organization_id, meeting_confirm) values ($1, true)", [org])))).code).toBe("42501");
    await settings({ day: false }, org, admin.id);
    expect(await asUser(member.id, async (q) => (await q("update public.org_message_settings set meeting_confirm = true where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await asUser(otherOwner.id, async (q) => (await q("update public.org_message_settings set meeting_confirm = true where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await asAdmin(async (q) => (await one<{ c: boolean }>(q, "select meeting_confirm as c from public.org_message_settings where organization_id = $1", [org])).c)).toBe(false);
    // the app's table is closed to clients
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.meeting_customer_messages")))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select * from app.meeting_customer_messages")))).code).toBe("42501");
  });

  it("the confirmation: queued with the meeting, at its start; never for a block, an internal meeting or one about to start", async () => {
    await settings({ confirm: true });
    const m = await meeting(60 * 48);
    const queued = await jobs(m);
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({
      channel: "sms",
      contact_id: dana,
      message_type: "meeting_reminder",
      template_id: await template("meeting_confirm", "sms"),
      meeting_id: m,
      event_at: expect.any(String),
    });
    // a confirmation ends 2 hours from now (not sent by then = cancelled by the send check), never after the start
    const twoHours = await asAdmin(async (q) => (await one<{ t: Date }>(q, "select now() + interval '2 hours' as t")).t);
    expect(Math.abs(new Date(queued[0].payload.event_at as string).getTime() - twoHours.getTime())).toBeLessThan(5_000);
    const soon = await meeting(60);
    expect(new Date((await jobs(soon))[0].payload.event_at as string).getTime()).toBe(Math.floor((await startOf(soon)).getTime() / 1000) * 1000);
    expect(await rows(m)).toEqual([{ kind: "confirm", outcome: "queued" }]);
    // the reminder job does not confirm again
    await run();
    expect(await jobs(m)).toHaveLength(1);

    expect(await jobs(await meeting(60 * 48, { block: true }))).toEqual([]);
    expect(await jobs(await meeting(60 * 48, { contact: null }))).toEqual([]);
    expect(await jobs(await meeting(10))).toEqual([]);
    // a lead as the customer
    const lead = await insertLead(owner.id, org, { phone: "0507654321" });
    const ml = await meeting(60 * 48, { contact: null, lead });
    expect((await jobs(ml))[0].payload).toMatchObject({ lead_id: lead, channel: "sms" });
    expect((await jobs(ml))[0].payload).not.toHaveProperty("contact_id");
    // a read-only business sends nothing
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await jobs(await asAdmin(async (q) =>
        (await one<{ id: string }>(q, "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id) values ($1, 'x', now() + interval '2 days', now() + interval '2 days 1 hour', $2) returning id", [org, dana])).id,
      ))).toEqual([]);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("the channel: the preferred one when SMS or email, then SMS, then email, only with an address and an active template", async () => {
    const byEmail = await contact(org, { phone: "0501112222", email: "dana@example.test", preferred: "email" });
    expect((await jobs(await meeting(60 * 48, { contact: byEmail })))[0].payload).toMatchObject({ channel: "email", template_id: await template("meeting_confirm", "email") });
    const whatsappFirst = await contact(org, { phone: "0501113333", email: "w@example.test", preferred: "whatsapp" });
    expect((await jobs(await meeting(60 * 48, { contact: whatsappFirst })))[0].payload).toMatchObject({ channel: "sms" });
    const emailOnly = await contact(org, { phone: null, email: "only@example.test" });
    expect((await jobs(await meeting(60 * 48, { contact: emailOnly })))[0].payload).toMatchObject({ channel: "email" });
    const nothing = await contact(org, { phone: null, email: null });
    const mn = await meeting(60 * 48, { contact: nothing });
    expect(await jobs(mn)).toEqual([]);
    expect(await rows(mn)).toEqual([{ kind: "confirm", outcome: "no_template" }]);
    // the SMS template switched off: the email one, else nothing
    const sms = await template("meeting_confirm", "sms");
    await asUser(owner.id, (q) => q("update public.message_templates set is_active = false where id = $1", [sms]));
    try {
      expect(await jobs(await meeting(60 * 48))).toEqual([]);
    } finally {
      await asUser(owner.id, (q) => q("update public.message_templates set is_active = true where id = $1", [sms]));
    }
    // a template that cannot be sent queues nothing and tells the owners and admins
    await asUser(owner.id, (q) => q("update public.message_templates set body = body || ' www.example.com' where id = $1", [sms]));
    try {
      const bad = await meeting(60 * 48);
      expect(await jobs(bad)).toEqual([]);
      expect(await rows(bad)).toEqual([{ kind: "confirm", outcome: "template:external_link" }]);
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and user_id = $2 and type = 'system' and entity_id = $3", [org, admin.id, sms]))).toBe(1);
    } finally {
      await asUser(owner.id, (q) => q("update public.message_templates set body = replace(body, ' www.example.com', '') where id = $1", [sms]));
    }
  });

  it("re-planning: a move replaces the waiting message, a cancel or a delete cancels it, counted as cancellations", async () => {
    const before = await asAdmin(async (q) =>
      Number((await q<{ n: number }>("select coalesce(sum(pending), 0)::int as n from app.job_cancel_counts where organization_id = $1 and reason = 'meeting_changed'", [org])).rows[0]?.n ?? 0),
    );
    const m = await meeting(60 * 48);
    await asUser(owner.id, (q) => q("update public.meetings set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = $1", [m]));
    const moved = await jobs(m);
    expect(moved.map((j) => [j.status, j.last_error])).toEqual([
      ["refused", "refused:meeting_changed"],
      ["queued", null],
    ]);
    // (182) a move sends "moved", not a second confirmation, and is not held by the address's one confirmation a day
    expect(moved[1].payload.template_id).toBe(await template("meeting_moved", "sms"));
    expect((await rows(m)).map((r) => r.kind)).toEqual(["confirm", "moved"]);
    // a title change touches nothing
    await asUser(owner.id, (q) => q("update public.meetings set title = 'פגישה חדשה' where id = $1", [m]));
    expect((await jobs(m)).map((j) => j.status)).toEqual(["refused", "queued"]);
    // cancelled
    await asUser(owner.id, (q) => q("update public.meetings set status = 'cancelled' where id = $1", [m]));
    expect((await jobs(m)).map((j) => j.status)).toEqual(["refused", "refused"]);
    // deleted
    const d = await meeting(60 * 48);
    const dJob = (await jobs(d))[0].id;
    await asUser(owner.id, (q) => q("delete from public.meetings where id = $1", [d]));
    expect(await asAdmin(async (q) => (await one<{ s: string; e: string }>(q, "select status as s, last_error as e from app.jobs where id = $1", [dJob])))).toEqual({
      s: "refused",
      e: "refused:meeting_changed",
    });
    const after = await asAdmin(async (q) =>
      Number((await q<{ n: number }>("select coalesce(sum(pending), 0)::int as n from app.job_cancel_counts where organization_id = $1 and reason = 'meeting_changed'", [org])).rows[0]?.n ?? 0),
    );
    expect(after - before).toBe(3);
    // a job a worker holds is left alone
    const held = await meeting(60 * 48);
    await asAdmin((q) => q("update app.jobs set status = 'running', lease_id = gen_random_uuid(), locked_until = now() + interval '1 minute' where payload ->> 'meeting_id' = $1", [held]));
    await asUser(owner.id, (q) => q("update public.meetings set status = 'cancelled' where id = $1", [held]));
    expect((await jobs(held)).map((j) => j.status)).toEqual(["running"]);
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where payload ->> 'meeting_id' = $1", [held]));
  });

  it("the reminders: 24 hours and an hour before, once each, a late one skipped, not right after a confirmation", async () => {
    await settings({ day: true, hour: true });
    const day = await meeting(60 * 23 + 30);
    const hour = await meeting(45);
    const late = await meeting(10);
    const far = await meeting(60 * 30);
    expect(await jobs(day)).toEqual([]);
    expect(await run()).toBe(2);
    expect((await jobs(day)).map((j) => j.payload.template_id)).toEqual([await template("meeting_day", "sms")]);
    expect((await jobs(hour)).map((j) => j.payload.template_id)).toEqual([await template("meeting_hour", "sms")]);
    expect(await rows(day)).toEqual([{ kind: "day", outcome: "queued" }]);
    expect(await rows(hour)).toEqual([{ kind: "hour", outcome: "queued" }]);
    expect(await jobs(late)).toEqual([]);
    expect(await jobs(far)).toEqual([]);
    // once
    expect(await run()).toBe(0);
    expect(await jobs(day)).toHaveLength(1);
    // the day reminder of a meeting moved into tomorrow's window again: once more, for the new start
    await asUser(owner.id, (q) => q("update public.meetings set starts_at = starts_at + interval '10 minutes', ends_at = ends_at + interval '10 minutes' where id = $1", [day]));
    expect(await run()).toBe(1);
    expect((await jobs(day)).map((j) => j.status)).toEqual(["refused", "queued"]);
    // switched off: nothing
    await settings({});
    expect(await jobs(await meeting(45))).toEqual([]);
    await run();
    // confirmation just queued: the day reminder is skipped
    await settings({ confirm: true, day: true });
    const fresh = await meeting(60 * 23 + 30);
    await run();
    expect(await rows(fresh)).toEqual([{ kind: "confirm", outcome: "queued" }]);
    await settings({});
  });

  it("a changed customer: the waiting reminder is cancelled and queued again for the new one, no second confirmation", async () => {
    await settings({ confirm: true, day: true });
    const m = await meeting(60 * 48);
    await settings({ hour: true });
    await asAdmin((q) => q("update public.meetings set starts_at = now() + interval '45 minutes', ends_at = now() + interval '105 minutes' where id = $1", [m]));
    await run();
    // the confirmation of the first start was replaced by the move (no confirmation while the switch is off), then the hour reminder
    expect((await jobs(m)).map((j) => [j.status, j.payload.contact_id])).toEqual([
      ["refused", dana],
      ["queued", dana],
    ]);
    const yael = await contact(org, { phone: "0509998888" });
    await asUser(owner.id, (q) => q("update public.meetings set contact_id = $2 where id = $1", [m, yael]));
    await run();
    const after = await jobs(m);
    expect(after.map((j) => [j.status, j.payload.contact_id])).toEqual([
      ["refused", dana],
      ["refused", dana],
      ["queued", yael],
    ]);
    // no confirmation for the new customer
    expect(await rows(m)).toEqual([
      { kind: "confirm", outcome: "replaced" },
      { kind: "hour", outcome: "queued" },
    ]);
    expect(after[2].payload.template_id).toBe(await template("meeting_hour", "sms"));
    await settings({});
  });

  it("tenant isolation: another business's switches, meetings and templates are its own", async () => {
    await settings({ confirm: true, day: true, hour: true });
    await setKey(other, true);
    const theirs = await contact(other, { phone: "0502223333" });
    const m = await meeting(45, { orgId: other, contact: theirs, by: otherOwner.id });
    // the other business has not switched anything on
    expect(await jobs(m)).toEqual([]);
    await run([org, other]);
    expect(await jobs(m)).toEqual([]);
    // an outsider cannot link our contact to their meeting, nor touch ours
    expect((await pgError(meeting(60 * 48, { orgId: other, contact: dana, by: otherOwner.id }))).code).toMatch(/23503|42501/);
    // their switches on: their own template, their own business on the job
    await settings({ confirm: true }, other, otherOwner.id);
    const m2 = await meeting(60 * 48, { orgId: other, contact: theirs, by: otherOwner.id });
    const job = (await jobs(m2))[0];
    expect(job.payload.template_id).toBe(await template("meeting_confirm", "sms", other));
    expect(await asAdmin(async (q) => (await one<{ o: string }>(q, "select organization_id as o from app.jobs where id = $1", [job.id])).o)).toBe(other);
    // a run for one business leaves the other's due reminders alone
    await settings({ hour: true }, other, otherOwner.id);
    const m3 = await meeting(45, { orgId: other, contact: theirs, by: otherOwner.id });
    await run([org]);
    expect(await jobs(m3)).toEqual([]);
    await run([other]);
    expect(await jobs(m3)).toHaveLength(1);
    await settings({});
    await settings({}, other, otherOwner.id);
  });

  it("end to end: the queued confirmation passes the send check; a pause holds it; a blocklisted address refuses it", async () => {
    // always inside the sending window
    await asAdmin((q) => q("update public.org_message_settings set window_from = '00:00', window_until = '24:00', skip_rest_days = false where organization_id = $1", [org]));
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where organization_id = $1 and status in ('queued', 'failed')", [org]));
    await settings({ confirm: true });
    const claim = async (id: string): Promise<Claimed> => {
      const claimed = await asService(async (q) => (await one<{ r: Claimed[] }>(q, "select public.claim_jobs(array['message.send'], 100) as r")).r);
      const c = claimed.find((r) => r.id === id);
      expect(c, "claimed").toBeDefined();
      return c as Claimed;
    };
    const maySend = (c: Claimed) => asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.job_message_may_send($1, $2) as r", [c.id, c.lease])).r);

    const m = await meeting(60 * 48);
    const id = (await jobs(m))[0].id;
    expect(await maySend(await claim(id))).toEqual({ may_send: true });
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where id = $1", [id]));

    // HEB-09: while the business paused sending the message waits, uncounted
    await asUser(owner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'בדיקה')", [org]));
    try {
      const p = await meeting(60 * 48);
      const pid = (await jobs(p))[0].id;
      expect(await maySend(await claim(pid))).toMatchObject({ may_send: false, reason: "sending_paused", retry: true });
      expect((await jobs(p))[0]).toMatchObject({ status: "queued", last_error: "waiting:sending_paused" });
      await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where id = $1", [pid]));
    } finally {
      await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    }

    // CNS-06: a service message never goes to a blocklisted address
    const listed = await contact(org, { phone: "0504445555" });
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'all', $2, 'complaint')", [org, ["0504445555"]]));
    const b = await meeting(60 * 48, { contact: listed });
    const bid = (await jobs(b))[0].id;
    const answer = await maySend(await claim(bid));
    expect(answer.may_send).toBe(false);
    expect((await jobs(b))[0].status).toBe("refused");
    await settings({});
  });

  // a business of its own (key on), so the counts of the tests above stay out
  const newBiz = async (label: string, switches: { confirm?: boolean; day?: boolean; hour?: boolean }) => {
    const o = await createUser(`cal12-${label}`);
    const id = await createOrg(o.id, `עסק ${label}`);
    await setKey(id, true);
    await settings(switches, id, o.id);
    const c = await contact(id, { phone: "0521234567" });
    return { owner: o, org: id, contact: c };
  };
  const series = (by: string, orgId: string, contactId: string, starts: string[]) =>
    asUser(by, async (q) =>
      (
        await one<{ r: { series_id: string; ids: string[] } }>(q, "select public.create_meeting_series($1, $2, $3, '{}'::uuid[]) as r", [
          orgId,
          JSON.stringify({ title: "טיפול", meeting_type: "in_person", reminder_minutes: 15, contact_id: contactId }),
          JSON.stringify(starts.map((at) => ({ starts_at: at, ends_at: new Date(new Date(at).getTime() + 3_600_000).toISOString() }))),
        ])
      ).r,
    );
  const runWith = (orgs: string[], config: Record<string, string>) =>
    asAdmin(async (q) => {
      for (const [k, v] of Object.entries(config)) await q("select set_config($1, $2, true)", [k, v]);
      return (await one<{ n: number }>(q, "select app.send_meeting_customer_reminders($1) as n", [orgs])).n;
    });
  const queuedIn = (orgId: string) =>
    asAdmin((q) => count(q, "select 1 from app.jobs where organization_id = $1 and payload ? 'meeting_id' and status = 'queued'", [orgId]));
  const failures = (meetingId: string) =>
    asAdmin(async (q) => one<{ f: number; o: string }>(q, "select failures as f, outcome as o from app.meeting_customer_messages where meeting_id = $1", [meetingId]));

  it("a series: the confirmation only for its first meeting, on insert and on a move; reminders follow every member", async () => {
    const b = await newBiz("series", { confirm: true, hour: true });
    const week = (n: number) => new Date(Date.now() + (n * 7 + 3) * 86_400_000).toISOString();
    const r = await series(b.owner.id, b.org, b.contact, [week(0), week(1), week(2)]);
    expect(await jobs(r.ids[0])).toHaveLength(1);
    expect(await jobs(r.ids[1])).toEqual([]);
    // moving the second: no confirmation; moving the first: a new one
    const later = "update public.meetings set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1";
    await asUser(b.owner.id, (q) => q(later, [r.ids[1]]));
    expect(await jobs(r.ids[1])).toEqual([]);
    await asUser(b.owner.id, (q) => q(later, [r.ids[0]]));
    expect((await jobs(r.ids[0])).map((j) => j.status)).toEqual(["refused", "queued"]);
    // a member of the series 45 minutes ahead gets its hour reminder
    await asAdmin((q) => q("update public.meetings set starts_at = now() + interval '45 minutes', ends_at = now() + interval '105 minutes' where id = $1", [r.ids[2]]));
    await run([b.org]);
    expect((await rows(r.ids[2])).map((x) => x.kind)).toEqual(["hour"]);
  });

  it("planned again after a cancel: a new confirmation at the same start", async () => {
    const b = await newBiz("replan", { confirm: true });
    const m = await meeting(60 * 48, { orgId: b.org, contact: b.contact, by: b.owner.id });
    const first = (await jobs(m))[0].id;
    // the first one went out
    await asAdmin((q) => q("update app.jobs set status = 'done' where id = $1", [first]));
    await asUser(b.owner.id, (q) => q("update public.meetings set status = 'cancelled' where id = $1", [m]));
    await freshDay(b.org);
    await asUser(b.owner.id, (q) => q("update public.meetings set status = 'planned' where id = $1", [m]));
    expect((await jobs(m)).map((j) => j.status)).toEqual(["done", "queued"]);
  });

  it("the job: caps per business and run, businesses take turns, a row that raises is skipped after 3 failures", async () => {
    const a = await newBiz("turn-a", { hour: true });
    const b = await newBiz("turn-b", { hour: true });
    for (const biz of [a, b]) {
      await meeting(40, { orgId: biz.org, contact: biz.contact, by: biz.owner.id });
      await meeting(45, { orgId: biz.org, contact: biz.contact, by: biz.owner.id });
    }
    const orgs = [a.org, b.org];
    expect(await runWith(orgs, { "app.meeting_customer_limit": "1" })).toBe(1);
    expect((await queuedIn(a.org)) + (await queuedIn(b.org))).toBe(1);
    // the other business has its turn
    expect(await runWith(orgs, { "app.meeting_customer_limit": "1" })).toBe(1);
    expect([await queuedIn(a.org), await queuedIn(b.org)]).toEqual([1, 1]);
    // one a business per run
    expect(await runWith(orgs, { "app.meeting_customer_per_org": "1" })).toBe(2);
    expect([await queuedIn(a.org), await queuedIn(b.org)]).toEqual([2, 2]);

    // a row that raises: counted, tried again, skipped after 3; the run goes on with the others
    const c = await newBiz("fail", { hour: true });
    const bad = await meeting(45, { orgId: c.org, contact: c.contact, by: c.owner.id });
    const good = await meeting(50, { orgId: c.org, contact: c.contact, by: c.owner.id });
    const raiseFor = (id: string) =>
      asAdmin((q) =>
        q(`create or replace function public.cal12_test_raise() returns trigger language plpgsql as $f$
           begin if new.payload ->> 'meeting_id' = '${id}' then raise exception 'forced'; end if; return new; end $f$`),
      );
    await raiseFor(bad);
    await asAdmin((q) => q("create trigger cal12_test_raise before insert on app.jobs for each row execute function public.cal12_test_raise()"));
    try {
      expect(await run([c.org])).toBe(1);
      expect(await rows(good)).toEqual([{ kind: "hour", outcome: "queued" }]);
      expect(await failures(bad)).toEqual({ f: 1, o: "failed" });
      await run([c.org]);
      await run([c.org]);
      expect(await failures(bad)).toEqual({ f: 3, o: "failed" });
      await run([c.org]);
      expect(await failures(bad)).toEqual({ f: 3, o: "failed" });
      // a forced error in the meeting's trigger never fails the meeting's write
      await settings({ confirm: true, hour: true }, c.org, c.owner.id);
      await asAdmin((q) =>
        q(`create or replace function public.cal12_test_raise() returns trigger language plpgsql as $f$
           begin if new.organization_id = '${c.org}' then raise exception 'forced'; end if; return new; end $f$`),
      );
      const saved = await asUser(c.owner.id, async (q) =>
        (
          await one<{ id: string }>(
            q,
            "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id) values ($1, 'x', now() + interval '2 days', now() + interval '2 days 1 hour', $2) returning id",
            [c.org, c.contact],
          )
        ).id,
      );
      expect(await asAdmin((q) => count(q, "select 1 from public.meetings where id = $1", [saved]))).toBe(1);
      expect(await jobs(saved)).toEqual([]);
    } finally {
      await asAdmin((q) => q("drop trigger cal12_test_raise on app.jobs"));
      await asAdmin((q) => q("drop function public.cal12_test_raise()"));
    }
  });

  it("the job skips a business that cannot write or lacks the key", async () => {
    const b = await newBiz("closed", { hour: true });
    const m = await meeting(45, { orgId: b.org, contact: b.contact, by: b.owner.id });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [b.org]));
    await run([b.org]);
    expect(await rows(m)).toEqual([]);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [b.org]));
    await setKey(b.org, false);
    await run([b.org]);
    expect(await rows(m)).toEqual([]);
    await setKey(b.org, true);
    await run([b.org]);
    expect(await rows(m)).toEqual([{ kind: "hour", outcome: "queued" }]);
  });

  it("a stranger's number gets nothing automatic until staff touch the record; then confirmations, reminders, the daily cap", async () => {
    const b = await newBiz("booking", { confirm: true, hour: true });
    const status = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.lead_statuses where organization_id = $1 and is_default", [b.org])).id);
    // as the booking page does, twice, in separate transactions: the first makes the lead, the second matches it
    const bookStranger = (lead: string | null, minutes: number) =>
      asAdmin(async (q) => {
        const id =
          lead ??
          (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, phone) values ($1, $2, 'זר', '0541112222') returning id", [b.org, status])).id;
        const m = (
          await one<{ id: string }>(
            q,
            "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'תור', now() + make_interval(mins => $3), now() + make_interval(mins => $3 + 60), $2) returning id",
            [b.org, id, minutes],
          )
        ).id;
        return { lead: id, meeting: m };
      });
    const first = await bookStranger(null, 60 * 48);
    await freshDay(b.org);
    const second = await bookStranger(first.lead, 45);
    expect(await jobs(first.meeting)).toEqual([]);
    expect(await rows(first.meeting)).toEqual([{ kind: "confirm", outcome: "untrusted" }]);
    expect(await jobs(second.meeting)).toEqual([]);
    // its hour reminder waits too
    await run([b.org]);
    expect(await rows(second.meeting)).toEqual([
      { kind: "confirm", outcome: "untrusted" },
      { kind: "hour", outcome: "untrusted" },
    ]);
    // a person logs a call: the next reminder goes (tried again while its window lasts), and a new booking is confirmed
    await asUser(b.owner.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה', $2)", [b.org, first.lead]));
    await run([b.org]);
    expect(await jobs(second.meeting)).toHaveLength(1);
    await freshDay(b.org);
    const third = await bookStranger(first.lead, 60 * 72);
    expect(await rows(third.meeting)).toEqual([{ kind: "confirm", outcome: "queued" }]);

    // a contact a person made, a meeting without a session: confirmed, up to the daily cap (lowered to 2 here)
    const known = await asUser(b.owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, phone) values ($1, 'ידועה', '0533334444') returning id", [b.org])).id,
    );
    const book = async () => {
      await freshDay(b.org);
      return asAdmin(async (q) => {
        await q("select set_config('app.meeting_customer_day_cap', '3', true)");
        return (
          await one<{ id: string }>(
            q,
            "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id) values ($1, 'תור', now() + interval '2 days', now() + interval '2 days 1 hour', $2) returning id",
            [b.org, known],
          )
        ).id;
      });
    };
    // the third's confirmation and the second's reminder took two of today's three places
    const m1 = await book();
    const m2 = await book();
    const m3 = await book();
    expect(await rows(m1)).toEqual([{ kind: "confirm", outcome: "queued" }]);
    expect(await rows(m2)).toEqual([{ kind: "confirm", outcome: "cap" }]);
    expect(await jobs(m3)).toEqual([]);
    // one notice that day, counts only
    const notices = await asAdmin(async (q) =>
      (
        await q<{ body: string }>(
          "select body from public.notifications where organization_id = $1 and user_id = $2 and type = 'system' and title = 'הודעות פגישה ללקוחות נעצרו להיום'",
          [b.org, b.owner.id],
        )
      ).rows,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0].body).toContain("3");
  });

  it("moving back to an earlier start queues again; a move clears the customer's confirmation", async () => {
    const b = await newBiz("moveback", { confirm: true });
    const m = await meeting(60 * 48, { orgId: b.org, contact: b.contact, by: b.owner.id });
    const first = (await jobs(m))[0].id;
    await asAdmin((q) => q("update app.jobs set status = 'done' where id = $1", [first]));
    const shift = (hours: number) =>
      asUser(b.owner.id, (q) =>
        q("update public.meetings set starts_at = starts_at + make_interval(hours => $2), ends_at = ends_at + make_interval(hours => $2) where id = $1", [m, hours]),
      );
    await shift(1);
    await shift(-1);
    // confirm (sent), moved (cancelled by the move back), moved again for the first start
    expect((await jobs(m)).map((j) => j.status)).toEqual(["done", "refused", "queued"]);
    // the customer confirms, the meeting moves, the customer confirms again: two entries
    const claimed = await asService(async (q) => (await one<{ r: Claimed[] }>(q, "select public.claim_jobs(array['message.send'], 100) as r")).r);
    const job = (await jobs(m))[2];
    const lease = (claimed.find((c) => c.id === job.id) as Claimed).lease;
    const token = (await asService(async (q) => (await one<{ r: { token: string } }>(q, "select public.meeting_reminder_link($1, $2) as r", [job.id, lease])).r)).token;
    const confirm = () => asService(async (q) => (await one<{ r: unknown }>(q, "select public.booking_manage_confirm($1, null) as r", [token])).r);
    await confirm();
    await shift(2);
    await confirm();
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and metadata ->> 'kind' = 'booking_confirmed'", [b.contact]))).toBe(2);
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where organization_id = $1 and status = 'running'", [b.org]));
  });

  it("a purged contact: its waiting message is cancelled, the reminder goes to the meeting's lead", async () => {
    const b = await newBiz("purge", { confirm: true, hour: true });
    const lead = await insertLead(b.owner.id, b.org, { phone: "0531231234" });
    const m = await asUser(b.owner.id, async (q) =>
      (
        await one<{ id: string }>(
          q,
          "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id, lead_id) values ($1, 'x', now() + interval '45 minutes', now() + interval '105 minutes', $2, $3) returning id",
          [b.org, b.contact, lead],
        )
      ).id,
    );
    // the confirmation went to the contact; the hour reminder waits (a confirmation was queued a moment ago)
    expect((await jobs(m)).map((j) => j.payload.contact_id)).toEqual([b.contact]);
    await asAdmin((q) => q("delete from public.contacts where id = $1", [b.contact]));
    expect((await jobs(m)).map((j) => j.status)).toEqual(["refused"]);
    // the confirmation is not sent again for the changed customer; the hour reminder (still within 30 minutes of the
    // confirmation) waits, then goes to the lead
    await asAdmin((q) => q("update app.meeting_customer_messages set created_at = now() - interval '1 hour' where meeting_id = $1", [m]));
    await run([b.org]);
    expect((await jobs(m)).map((j) => [j.status, j.payload.lead_id ?? null])).toEqual([
      ["refused", null],
      ["queued", lead],
    ]);
  });

  it("(179) one confirmation per address a business day, keyed (no key = nothing); the business keeps no address", async () => {
    const b = await newBiz("address", { confirm: true });
    const first = await meeting(60 * 48, { orgId: b.org, contact: b.contact, by: b.owner.id });
    const second = await meeting(60 * 72, { orgId: b.org, contact: b.contact, by: b.owner.id, keepDay: true });
    expect(await rows(first)).toEqual([{ kind: "confirm", outcome: "queued" }]);
    expect(await rows(second)).toEqual([{ kind: "confirm", outcome: "address_cap" }]);
    // another contact with the same phone is the same address
    const twin = await contact(b.org, { phone: "052-1234567" });
    const third = await meeting(60 * 72, { orgId: b.org, contact: twin, by: b.owner.id, keepDay: true });
    expect(await rows(third)).toEqual([{ kind: "confirm", outcome: "address_cap" }]);
    // only bucket numbers and days are kept
    const kept = await asAdmin(async (q) => (await q("select * from app.meeting_confirm_buckets where organization_id = $1", [b.org])).rows);
    expect(kept).toHaveLength(1);
    expect(Object.keys(kept[0]).sort()).toEqual(["anon_sent", "bucket", "confirms", "day", "organization_id"]);
    // without the consent key nothing is confirmed
    await asAdmin((q) => q("update app.settings set value = '' where key = 'consent_hash_key'"));
    try {
      const keyless = await meeting(60 * 48, { orgId: b.org, contact: await contact(b.org, { phone: "0587776666" }), by: b.owner.id });
      expect(await rows(keyless)).toEqual([{ kind: "confirm", outcome: "no_key" }]);
    } finally {
      await asAdmin((q) => q("update app.settings set value = $1 where key = 'consent_hash_key'", [KEY]));
    }
  });

  it("(177) the link a message carries: minted for the job's lease holder only, a new one each time; the customer confirms with it", async () => {
    const b = await newBiz("link", { confirm: true });
    const m = await meeting(60 * 48, { orgId: b.org, contact: b.contact, by: b.owner.id });
    const job = (await jobs(m))[0];
    const mint = (jobId: string, lease: string | null) =>
      asService(async (q) => (await one<{ r: Record<string, string> }>(q, "select public.meeting_reminder_link($1, $2) as r", [jobId, lease])).r);
    // not claimed: no lease, nothing minted
    expect(await mint(job.id, "00000000-0000-0000-0000-000000000000")).toEqual({ refused: "stale" });
    const claim = async (jobId: string) => {
      const claimed = await asService(async (q) => (await one<{ r: Claimed[] }>(q, "select public.claim_jobs(array['message.send'], 100) as r")).r);
      const c = claimed.find((x) => x.id === jobId);
      expect(c, "claimed").toBeDefined();
      return c as Claimed;
    };
    const mine = await claim(job.id);
    const first = await mint(job.id, mine.lease);
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    const second = await mint(job.id, mine.lease);
    expect(second.token).not.toBe(first.token);
    // one link per meeting, the hash only; the earlier token no longer opens it
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_manage_links where meeting_id = $1", [m]))).toBe(1);
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from app.booking_manage_links where meeting_id = $1 and token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex')", [m, second.token]),
      ),
    ).toBe(1);
    const manage = (token: string) =>
      asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.booking_manage_public($1, null, null) as r", [token])).r);
    expect((await pgError(manage(first.token))).code).toBe("P0002");
    // a meeting set by staff: the page answers, with no change of time (no page) and the 24-hour threshold
    expect(await manage(second.token)).toMatchObject({ status: "planned", can_cancel: true, change: null, notice_hours: 24 });
    // the client roles cannot mint or confirm
    expect((await pgError(asUser(b.owner.id, (q) => q("select public.meeting_reminder_link($1, $2)", [job.id, mine.lease])))).code).toBe("42501");
    expect((await pgError(asUser(b.owner.id, (q) => q("select public.booking_manage_confirm($1)", [second.token])))).code).toBe("42501");
    // confirm: once, a timeline entry, the link marked
    const confirm = (token: string, ip: string | null = null) =>
      asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.booking_manage_confirm($1, $2) as r", [token, ip])).r);
    expect(await confirm(second.token)).toEqual({ status: "confirmed" });
    expect(await confirm(second.token)).toEqual({ status: "confirmed" });
    expect(await asAdmin((q) => count(q, "select 1 from public.activities where contact_id = $1 and metadata ->> 'kind' = 'booking_confirmed'", [b.contact]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_manage_links where meeting_id = $1 and confirmed_at is not null", [m]))).toBe(1);
    expect((await pgError(confirm("f".repeat(64)))).code).toBe("P0002");
    // the sender limit of cancel and change: 5 in 10 minutes per sender
    const c3 = await meeting(60 * 48, { orgId: b.org, contact: await contact(b.org, { phone: "0549991111" }), by: b.owner.id });
    const j3 = (await jobs(c3))[0];
    const t3 = (await mint(j3.id, (await claim(j3.id)).lease)).token;
    const sender = "a".repeat(64);
    await asAdmin((q) =>
      q("insert into app.booking_requests (page_id, organization_id, ip_hash, outcome) select $1, $2, app.booking_sender($1, $3), 'cancelled' from generate_series(1, 5)", [
        c3,
        b.org,
        sender,
      ]),
    );
    expect(await pgError(confirm(t3, sender))).toMatchObject({ hint: "rate_limited" });
    expect(await confirm(t3, "b".repeat(64))).toEqual({ status: "confirmed" });
    // a meeting that changed since the job was queued gets no link
    await asAdmin((q) => q("update public.meetings set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1", [m]));
    expect(await mint(job.id, mine.lease)).toEqual({ refused: "meeting_changed" });
    // a cancelled meeting cannot be confirmed
    const c2 = await meeting(60 * 48, { orgId: b.org, contact: await contact(b.org, { phone: "0549990000" }), by: b.owner.id });
    const j2 = (await jobs(c2))[0];
    const t2 = (await mint(j2.id, (await claim(j2.id)).lease)).token;
    await asAdmin((q) => q("update public.meetings set status = 'cancelled' where id = $1", [c2]));
    expect(await pgError(confirm(t2))).toMatchObject({ code: "P0001", hint: "booking:confirm_closed" });
    // a finished job mints nothing
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where organization_id = $1 and status = 'running'", [b.org]));
    expect(await mint(j2.id, "00000000-0000-0000-0000-000000000000")).toEqual({ refused: "stale" });
  });

  it("third review: public bookings on a known customer's phone send at most 3 a business day", async () => {
    const b = await newBiz("anon-cap", { hour: true });
    const known = await asUser(b.owner.id, async (q) =>
      (await one<{ id: string }>(q, "insert into public.contacts (organization_id, first_name, phone) values ($1, 'ידוע', '0536667777') returning id", [b.org])).id,
    );
    // four meetings booked on the public page (no session), each due for its hour reminder
    const ids: string[] = [];
    for (const minutes of [40, 42, 44, 46]) {
      ids.push(
        await asAdmin(async (q) =>
          (
            await one<{ id: string }>(
              q,
              "insert into public.meetings (organization_id, title, starts_at, ends_at, contact_id) values ($1, 'תור', now() + make_interval(mins => $3), now() + make_interval(mins => $3 + 60), $2) returning id",
              [b.org, known, minutes],
            )
          ).id,
        ),
      );
    }
    expect(await run([b.org])).toBe(3);
    const outcomes = await Promise.all(ids.map(async (id) => (await rows(id))[0]?.outcome));
    expect(outcomes.filter((o) => o === "queued")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "address_cap")).toHaveLength(1);
    // a meeting a person set for the same customer is not held by it
    const staff = await meeting(48, { orgId: b.org, contact: known, by: b.owner.id, keepDay: true });
    await run([b.org]);
    expect(await rows(staff)).toEqual([{ kind: "hour", outcome: "queued" }]);
  });

  it("third review: a staff move of a publicly booked meeting sends 'moved'; a cancel clears the confirmation", async () => {
    const b = await newBiz("staffmove", { confirm: true });
    const status = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.lead_statuses where organization_id = $1 and is_default", [b.org])).id);
    const booked = await asAdmin(async (q) => {
      const lead = (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, phone) values ($1, $2, 'זרה', '0547778888') returning id", [b.org, status])).id;
      return (
        await one<{ id: string }>(
          q,
          "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id) values ($1, 'תור', now() + interval '2 days', now() + interval '2 days 1 hour', $2) returning id",
          [b.org, lead],
        )
      ).id;
    });
    expect(await rows(booked)).toEqual([{ kind: "confirm", outcome: "untrusted" }]);
    await freshDay(b.org);
    await asUser(b.owner.id, (q) => q("update public.meetings set starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour' where id = $1", [booked]));
    // the move marks the old start's row replaced (moving back would try it again)
    expect((await rows(booked)).map((r) => [r.kind, r.outcome])).toEqual([
      ["confirm", "replaced"],
      ["moved", "queued"],
    ]);
    // the customer confirms through the link, then the meeting is cancelled: the confirmation is cleared
    const job = (await jobs(booked))[0];
    const claimed = await asService(async (q) => (await one<{ r: Claimed[] }>(q, "select public.claim_jobs(array['message.send'], 100) as r")).r);
    const lease = (claimed.find((c) => c.id === job.id) as Claimed).lease;
    const token = (await asService(async (q) => (await one<{ r: { token: string } }>(q, "select public.meeting_reminder_link($1, $2) as r", [job.id, lease])).r)).token;
    await asService((q) => q("select public.booking_manage_confirm($1, null)", [token]));
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_manage_links where meeting_id = $1 and confirmed_at is not null", [booked]))).toBe(1);
    await asUser(b.owner.id, (q) => q("update public.meetings set status = 'cancelled' where id = $1", [booked]));
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_manage_links where meeting_id = $1 and confirmed_at is not null", [booked]))).toBe(0);
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where organization_id = $1 and status = 'running'", [b.org]));
  });

  it("fourth review: the customer's own change through the link keeps a meeting a person moved; a stranger's stays silent", async () => {
    const b = await newBiz("carry", { confirm: true });
    const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'UTC' where id = $1", [b.org]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [b.org, JSON.stringify(ALL_WEEK)],
      );
    });
    const pageToken = await asUser(b.owner.id, async (q) => {
      const type = (await one<{ id: string }>(q, "insert into public.meeting_types (organization_id, name, duration_minutes, meeting_format) values ($1, 'ייעוץ', 60, 'in_person') returning id", [b.org])).id;
      return (
        await one<{ token: string }>(
          q,
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, max_days_ahead, slot_step_minutes) values ($1, $2, 'תורים', $3, 0, 30, 60) returning token",
          [b.org, b.owner.id, type],
        )
      ).token;
    });
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const at = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00Z`).toISOString();
    const book = (startsAt: string, phone: string) =>
      asService(async (q) =>
        (await one<{ r: Record<string, unknown> }>(q, "select public.booking_submit($1, $2, $3, null) as r", [pageToken, startsAt, JSON.stringify({ full_name: "לקוחה", phone })])).r,
      );
    const change = (token: string, startsAt: string) =>
      asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.booking_manage_change($1, $2, null) as r", [token, startsAt])).r);
    const meetingAt = (startsAt: string) =>
      asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.meetings where organization_id = $1 and starts_at = $2 and status = 'planned'", [b.org, startsAt])).id);

    // a stranger books; a person moves it (the stamp); the customer changes it through the link
    const booked = await book(at(day(5), "10:00"), "0548889999");
    expect(booked.status).toBe("booked");
    const first = await meetingAt(at(day(5), "10:00"));
    expect(await rows(first)).toEqual([{ kind: "confirm", outcome: "untrusted" }]);
    await asUser(b.owner.id, (q) => q("update public.meetings set starts_at = $2, ends_at = $3 where id = $1", [first, at(day(5), "12:00"), at(day(5), "13:00")]));
    expect((await rows(first)).map((r) => [r.kind, r.outcome])).toEqual([
      ["confirm", "replaced"],
      ["moved", "queued"],
    ]);
    await freshDay(b.org);
    const changed = await change(booked.manage_token as string, at(day(6), "10:00"));
    expect(changed).toMatchObject({ status: "booked" });
    const second = await meetingAt(at(day(6), "10:00"));
    expect(await rows(second)).toEqual([{ kind: "confirm", outcome: "queued" }]);
    // changed again the same day: still carried, but the address had its one confirmation today
    expect(await change(changed.manage_token as string, at(day(9), "10:00"))).toMatchObject({ status: "booked" });
    expect(await rows(await meetingAt(at(day(9), "10:00")))).toEqual([{ kind: "confirm", outcome: "address_cap" }]);

    // a stranger's booking changed the same way, never touched by a person: nothing
    const stranger = await book(at(day(7), "10:00"), "0547771111");
    await freshDay(b.org);
    expect(await change(stranger.manage_token as string, at(day(8), "10:00"))).toMatchObject({ status: "booked" });
    expect(await rows(await meetingAt(at(day(8), "10:00")))).toEqual([{ kind: "confirm", outcome: "untrusted" }]);
  });

  it("fourth review: a handover of a public booking stays untrusted; a staff move makes it person-made", async () => {
    const b = await newBiz("handover", { hour: true });
    const mate = await addMember(b.org, b.owner.id, "member", "cal12-mate");
    const status = await asAdmin(async (q) => (await one<{ id: string }>(q, "select id from public.lead_statuses where organization_id = $1 and is_default", [b.org])).id);
    const m = await asAdmin(async (q) => {
      const lead = (await one<{ id: string }>(q, "insert into public.leads (organization_id, status_id, full_name, phone, owner_id) values ($1, $2, 'זר', '0546665555', $3) returning id", [b.org, status, b.owner.id])).id;
      return (
        await one<{ id: string }>(
          q,
          "insert into public.meetings (organization_id, title, starts_at, ends_at, lead_id, owner_id) values ($1, 'תור', now() + interval '45 minutes', now() + interval '105 minutes', $2, $3) returning id",
          [b.org, lead, b.owner.id],
        )
      ).id;
    });
    await asUser(b.owner.id, (q) => q("select public.transfer_records($1, $2, $3)", [b.org, b.owner.id, mate.id]));
    const stamped = () => asAdmin(async (q) => (await one<{ s: Date | null; o: string }>(q, "select person_scheduled_at as s, owner_id as o from public.meetings where id = $1", [m])));
    expect(await stamped()).toEqual({ s: null, o: mate.id });
    await run([b.org]);
    expect(await rows(m)).toEqual([{ kind: "hour", outcome: "untrusted" }]);
    // a client can never write the stamp
    expect((await pgError(asUser(b.owner.id, (q) => q("update public.meetings set person_scheduled_at = now() where id = $1", [m])))).code).toBe("42501");
    // a staff move stamps it; the hour reminder of the new start goes
    await asUser(b.owner.id, (q) => q("update public.meetings set starts_at = starts_at + interval '5 minutes', ends_at = ends_at + interval '5 minutes' where id = $1", [m]));
    expect((await stamped()).s).not.toBeNull();
    await run([b.org]);
    expect((await rows(m)).map((r) => [r.kind, r.outcome])).toEqual([
      ["hour", "replaced"],
      ["hour", "queued"],
    ]);
  });

  it("third review: a link is minted only for a template that holds {קישור}", async () => {
    const b = await newBiz("nolink", { hour: true });
    const m = await meeting(45, { orgId: b.org, contact: b.contact, by: b.owner.id });
    await run([b.org]);
    const job = (await jobs(m))[0];
    const claimed = await asService(async (q) => (await one<{ r: Claimed[] }>(q, "select public.claim_jobs(array['message.send'], 100) as r")).r);
    const lease = (claimed.find((c) => c.id === job.id) as Claimed).lease;
    expect(await asService(async (q) => (await one<{ r: unknown }>(q, "select public.meeting_reminder_link($1, $2) as r", [job.id, lease])).r)).toEqual({
      refused: "no_link_field",
    });
    expect(await asAdmin((q) => count(q, "select 1 from app.booking_manage_links where meeting_id = $1", [m]))).toBe(0);
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where organization_id = $1 and status = 'running'", [b.org]));
  });
});

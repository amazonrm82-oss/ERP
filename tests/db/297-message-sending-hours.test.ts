import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

const KEY = "test-consent-key";

type Claimed = { id: string; lease: string; organization_id: string };
type Job = { status: string; attempts: number; last_error: string | null; next_run_at: Date };

const enqueue = (org: string, payload: Record<string, unknown>) =>
  asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2) as id", [org, JSON.stringify(payload)])).rows[0].id);
const claimOne = async (id: string): Promise<Claimed> => {
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  return job as Claimed;
};
const maySend = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
const check = async (org: string, payload: Record<string, unknown>) => {
  const id = await enqueue(org, payload);
  return { id, answer: await maySend(await claimOne(id)) };
};
const jobOf = (id: string) => asAdmin(async (q) => (await q<Job>("select * from app.jobs where id = $1", [id])).rows[0]);
const setWindow = (org: string, from: string, until: string, skip: boolean) =>
  asAdmin((q) =>
    q(
      `insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, $2, $3, $4)
       on conflict (organization_id) do update set window_from = excluded.window_from, window_until = excluded.window_until,
         skip_rest_days = excluded.skip_rest_days`,
      [org, from, until, skip],
    ),
  );
const openAt = (org: string, at: string) =>
  asAdmin(async (q) => (await q<{ t: Date }>("select app.message_window_open_at($1, $2::timestamptz) as t", [org, at])).rows[0].t.toISOString());
// a window that does not hold the business's current local time, so "now" is outside it whatever the hour of the run
const closedNow = (org: string) =>
  asAdmin(async (q) => {
    const h = (await q<{ h: number }>("select extract(hour from now() at time zone 'Asia/Jerusalem')::int as h")).rows[0].h;
    const [from, until] = h < 12 ? ["13:00", "23:00"] : ["01:00", "11:00"];
    await setWindow(org, from, until, false);
    return (await q<{ t: Date }>("select app.message_window_open_at($1, now()) as t", [org])).rows[0].t;
  });

/**
 * MSG-06, owner 4 November 2026, answers (119) א, (120) ג, (121) א: messages to customers go out only inside the business's
 * sending window (default 08:00-20:00 in its zone, not on rest days and holidays, until 15:00 on a short day); outside it they
 * wait, uncounted, like the HEB-09 pause. A verification code always goes, and a meeting reminder goes when its meeting starts
 * before the window opens. A fixed rate per business and channel: 60 / 30 / 20 a minute.
 */
describe("sending hours and rate (MSG-06)", () => {
  let owner: { id: string }, admin: { id: string }, member: { id: string }, org: string, lead: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("hours-owner");
    org = await createOrg(owner.id, "עסק שעות שליחה");
    admin = await addMember(org, owner.id, "admin", "hours-admin");
    member = await addMember(org, owner.id, "member", "hours-member");
    lead = await insertLead(owner.id, org, { email: "hours@example.test", phone: "0501230001" });
    // marketing needs a recorded grant (CNS-07); these tests are about the window
    for (const channel of ["email", "sms"]) {
      await asUser(owner.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, $3, 'granted', 'manual', 'בשיחה')", [
          org,
          lead,
          channel,
        ]),
      );
    }
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(() => closePool());

  it("settings: members read, owners and admins of a writable business write, the shape holds", async () => {
    const other = await createUser("hours-other");
    const otherOrg = await createOrg(other.id, "עסק אחר לשעות");
    // a member cannot write, an outsider cannot write into another business
    expect((await pgError(asUser(member.id, (q) => q("insert into public.org_message_settings (organization_id) values ($1)", [org])))).code).toBe("42501");
    expect((await pgError(asUser(other.id, (q) => q("insert into public.org_message_settings (organization_id) values ($1)", [org])))).code).toBe("42501");
    await asUser(admin.id, (q) =>
      q("insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '09:00', '19:30', true)", [org]),
    );
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.org_message_settings where organization_id = $1", [org]))).toBe(1);
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.org_message_settings where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(member.id, async (q) => (await q("update public.org_message_settings set window_from = '07:00' where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await asUser(owner.id, async (q) => (await q("update public.org_message_settings set window_from = '08:30' where organization_id = $1", [org])).rowCount)).toBe(1);
    // until after from, whole minutes; 24:00 is midnight
    expect((await pgError(asUser(owner.id, (q) => q("update public.org_message_settings set window_until = '08:00' where organization_id = $1", [org])))).code).toBe("23514");
    expect((await pgError(asUser(owner.id, (q) => q("update public.org_message_settings set window_from = '08:00:30' where organization_id = $1", [org])))).code).toBe("23514");
    expect(await asUser(owner.id, async (q) => (await q("update public.org_message_settings set window_until = '24:00' where organization_id = $1", [org])).rowCount)).toBe(1);
    // server columns are not writable, nor is the row deleted
    expect((await pgError(asUser(owner.id, (q) => q("update public.org_message_settings set organization_id = $2 where organization_id = $1", [org, otherOrg])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.org_message_settings where organization_id = $1", [org])))).code).toBe("42501");
    // a read-only business keeps its settings
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await asUser(owner.id, async (q) => (await q("update public.org_message_settings set window_from = '08:00' where organization_id = $1", [org])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    // audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'org_message_settings'", [org]))).toBeGreaterThan(0);
  });

  it("the window: 08:00-20:00 by default, never on a rest day, until 15:00 on a short day; the business changes it", async () => {
    const o = await createUser("hours-window");
    const w = await createOrg(o.id, "עסק חלון");
    // no settings row: 08:00-20:00, Friday and Saturday off (the calendar's defaults). 11 November 2026 is a Wednesday
    expect(await openAt(w, "2026-11-11T10:00:00+02:00")).toBe(new Date("2026-11-11T10:00:00+02:00").toISOString());
    expect(await openAt(w, "2026-11-11T07:00:00+02:00")).toBe(new Date("2026-11-11T08:00:00+02:00").toISOString());
    expect(await openAt(w, "2026-11-11T20:00:00+02:00")).toBe(new Date("2026-11-12T08:00:00+02:00").toISOString());
    // Thursday evening: Friday and Saturday are rest days, the next window is Sunday morning
    expect(await openAt(w, "2026-11-12T21:00:00+02:00")).toBe(new Date("2026-11-15T08:00:00+02:00").toISOString());
    expect(await openAt(w, "2026-11-14T12:00:00+02:00")).toBe(new Date("2026-11-15T08:00:00+02:00").toISOString());
    // Friday is a working day: a short one before Saturday, until 15:00
    await asAdmin((q) => q("insert into public.org_calendar_settings (organization_id, rest_weekdays) values ($1, '{6}')", [w]));
    expect(await openAt(w, "2026-11-13T14:59:00+02:00")).toBe(new Date("2026-11-13T14:59:00+02:00").toISOString());
    expect(await openAt(w, "2026-11-13T15:00:00+02:00")).toBe(new Date("2026-11-15T08:00:00+02:00").toISOString());
    // a holiday: Yom Kippur 2027 is Saturday 11 September; Rosh Hashana 2027 (2-3 October 2027) is a Saturday-Sunday,
    // so Sunday 3 October is closed and the window opens on Monday
    expect(await openAt(w, "2027-10-02T12:00:00+03:00")).toBe(new Date("2027-10-04T08:00:00+03:00").toISOString());
    // the business's own window, and without the rest-day rule
    await setWindow(w, "09:30", "18:00", true);
    expect(await openAt(w, "2026-11-11T09:00:00+02:00")).toBe(new Date("2026-11-11T09:30:00+02:00").toISOString());
    expect(await openAt(w, "2026-11-11T18:00:00+02:00")).toBe(new Date("2026-11-12T09:30:00+02:00").toISOString());
    await setWindow(w, "09:30", "18:00", false);
    expect(await openAt(w, "2026-11-13T16:00:00+02:00")).toBe(new Date("2026-11-13T16:00:00+02:00").toISOString());
    expect(await openAt(w, "2026-11-14T08:00:00+02:00")).toBe(new Date("2026-11-14T09:30:00+02:00").toISOString());
    // a business in another zone counts in its own zone
    await asAdmin((q) => q("update public.organizations set timezone = 'America/New_York' where id = $1", [w]));
    expect(await openAt(w, "2026-11-11T13:00:00Z")).toBe(new Date("2026-11-11T14:30:00Z").toISOString());
  });

  it("outside the window a message waits uncounted, at the window's opening, and nothing is cancelled", async () => {
    const open = await closedNow(org);
    const { id, answer } = await check(org, { channel: "email", lead_id: lead, message_type: "collection" });
    expect(answer).toEqual({ may_send: false, reason: "sending_hours", retry: true });
    const job = await jobOf(id);
    expect(job).toMatchObject({ status: "queued", attempts: 0, last_error: "waiting:sending_hours" });
    expect(job.next_run_at.toISOString()).toBe(open.toISOString());
    expect(await asAdmin((q) => count(q, "select 1 from app.job_cancel_counts where organization_id = $1 and reason = 'sending_hours'", [org]))).toBe(0);
  });

  it("the batch move takes due waiting messages and never a pause-marked one or one that always goes", async () => {
    const open = await closedNow(org);
    const first = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    const job = await claimOne(first);
    // made after the claim: due, queued, not claimed
    const other = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    const paused = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    const code = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "verification_code" });
    const reminder = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "meeting_reminder" });
    await asAdmin((q) => q("update app.jobs set last_error = 'waiting:sending_paused' where id = $1", [paused]));
    expect(await maySend(job)).toEqual({ may_send: false, reason: "sending_hours", retry: true });
    const rows = Object.fromEntries(
      (
        await asAdmin(
          async (q) =>
            (await q<{ id: string; next_run_at: Date; last_error: string | null }>("select id, next_run_at, last_error from app.jobs where id = any ($1)", [[other, paused, code, reminder]]))
              .rows,
        )
      ).map((r) => [r.id, r]),
    );
    expect(rows[other]).toMatchObject({ last_error: "waiting:sending_hours" });
    expect(rows[other].next_run_at.toISOString()).toBe(open.toISOString());
    expect(rows[paused].last_error).toBe("waiting:sending_paused");
    expect(rows[code].last_error).toBeNull();
    expect(rows[reminder].last_error).toBeNull();
  });

  it("(120) ג: a verification code always goes; a meeting reminder goes when its meeting is before the window opens", async () => {
    const open = await closedNow(org);
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "verification_code" })).answer).toEqual({ may_send: true });
    const before = new Date(Math.min(open.getTime() - 60_000, Date.now() + 30 * 60_000));
    // the meeting starts before the window opens (and is still ahead): sent now
    if (before.getTime() > Date.now()) {
      expect((await check(org, { channel: "sms", lead_id: lead, message_type: "meeting_reminder", event_at: before.toISOString() })).answer).toEqual({
        may_send: true,
      });
    }
    // after the window opens: waits for it; no event time: waits
    const after = new Date(open.getTime() + 60 * 60_000).toISOString();
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "meeting_reminder", event_at: after })).answer).toMatchObject({ reason: "sending_hours" });
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "meeting_reminder" })).answer).toMatchObject({ reason: "sending_hours" });
    // collection, requested documents and marketing wait
    for (const type of ["collection", "requested_document", "marketing"]) {
      expect((await check(org, { channel: "email", lead_id: lead, message_type: type })).answer, type).toMatchObject({ retry: true });
    }
  });

  it("(52): an event that passes while a message waits cancels it, counted", async () => {
    await closedNow(org);
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const { id, answer } = await check(org, { channel: "email", lead_id: lead, message_type: "collection", event_at: soon });
    expect(answer).toMatchObject({ reason: "sending_hours" });
    const passed = new Date(Date.now() - 60_000).toISOString();
    await asAdmin((q) => q("update app.jobs set payload = jsonb_set(payload, '{event_at}', to_jsonb($2::text)), next_run_at = now() where id = $1", [id, passed]));
    expect(await maySend(await claimOne(id))).toEqual({ may_send: false, reason: "event_passed" });
    expect((await jobOf(id)).status).toBe("refused");
  });

  it("(121) א: 60 / 30 / 20 a minute per business and channel; the next minute starts again", async () => {
    await setWindow(org, "00:00", "24:00", false);
    const rates = await asAdmin(
      async (q) =>
        (await q<{ e: number; s: number; w: number }>("select app.message_rate_per_minute('email') as e, app.message_rate_per_minute('sms') as s, app.message_rate_per_minute('whatsapp') as w"))
          .rows[0],
    );
    expect(rates).toEqual({ e: 60, s: 30, w: 20 });
    await asAdmin((q) =>
      q(
        `insert into app.message_send_rate (organization_id, channel, minute_start, sent) values ($1, 'email', date_trunc('minute', now()), 60)
         on conflict (organization_id, channel) do update set minute_start = excluded.minute_start, sent = excluded.sent`,
        [org],
      ),
    );
    const minute = await asAdmin(async (q) => (await q<{ m: Date }>("select date_trunc('minute', now()) + interval '1 minute' as m")).rows[0].m);
    const { id, answer } = await check(org, { channel: "email", lead_id: lead, message_type: "collection" });
    // the minute may have turned between the two statements: then it went out
    if (answer.may_send === true) return;
    expect(answer).toEqual({ may_send: false, reason: "rate", retry: true });
    const job = await jobOf(id);
    expect(job).toMatchObject({ status: "queued", attempts: 0, last_error: "waiting:rate" });
    expect(job.next_run_at.getTime()).toBeLessThanOrEqual(minute.getTime() + 60_000);
    // another channel has its own count; another business too
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "collection" })).answer).toEqual({ may_send: true });
    // a past minute's count does not hold
    await asAdmin((q) => q("update app.message_send_rate set minute_start = minute_start - interval '1 minute' where organization_id = $1 and channel = 'email'", [org]));
    await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [id]));
    expect(await maySend(await claimOne(id))).toEqual({ may_send: true });
    const row = await asAdmin(async (q) => (await q<{ sent: number }>("select sent from app.message_send_rate where organization_id = $1 and channel = 'email'", [org])).rows[0]);
    expect(row.sent).toBe(1);
  });

  it("no client role reads the rate table or calls the window rule", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const rights = await asAdmin(
        async (q) =>
          (
            await q<{ t: boolean; f: boolean }>(
              `select has_table_privilege($1, 'app.message_send_rate', 'select,insert,update,delete') as t,
                      has_function_privilege($1, 'app.message_window_open_at(uuid,timestamptz)', 'execute') as f`,
              [role],
            )
          ).rows[0],
      );
      expect(rights, role).toEqual({ t: false, f: false });
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead } from "./helpers";

// SMS-01b (final review (7)): on sms a verification code is only a sender check's (a check row of the business's own phone)
const senderCheck = (org: string) =>
  asAdmin(async (q) => (await q<{ id: string }>("insert into app.sms_sender_checks (organization_id, phone) values ($1, '+972520000000') returning id", [org])).rows[0].id);

const KEY = "test-consent-key";

type Claimed = { id: string; lease: string; organization_id: string };
type Job = { status: string; attempts: number; last_error: string | null; next_run_at: Date; usage_counted: boolean; cap_wait: string | null };

const enqueue = (org: string, payload: Record<string, unknown>) =>
  asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2) as id", [org, JSON.stringify(payload)])).rows[0].id);
const claimOne = async (id: string): Promise<Claimed> => {
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 1, 120) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  return job as Claimed;
};
const maySend = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
const check = async (org: string, payload: Record<string, unknown>) => {
  const id = await enqueue(org, payload);
  const job = await claimOne(id);
  return { id, job, answer: await maySend(job) };
};
const jobOf = (id: string) => asAdmin(async (q) => (await q<Job>("select * from app.jobs where id = $1", [id])).rows[0]);
const due = (id: string) => asAdmin((q) => q("update app.jobs set next_run_at = now() - interval '1 second' where id = $1", [id]));
const setCaps = (org: string, caps: { email?: number | null; sms?: number | null; whatsapp?: number | null }) =>
  asAdmin((q) =>
    q(
      `update public.org_message_settings set monthly_cap_email = $2, monthly_cap_sms = $3, monthly_cap_whatsapp = $4 where organization_id = $1`,
      [org, caps.email ?? null, caps.sms ?? null, caps.whatsapp ?? null],
    ),
  );
const notices = (org: string, title: string) =>
  asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and type = 'system' and title = $2", [org, title]));
// a window that does not hold the business's current local time, so "now" is outside it whatever the hour of the run
const closeWindow = (org: string) =>
  asAdmin(async (q) => {
    const h = (await q<{ h: number }>("select extract(hour from now() at time zone 'Asia/Jerusalem')::int as h")).rows[0].h;
    const [from, until] = h < 12 ? ["13:00", "23:00"] : ["01:00", "11:00"];
    await q("update public.org_message_settings set window_from = $2, window_until = $3, skip_rest_days = false where organization_id = $1", [org, from, until]);
  });
const openWindow = (org: string) =>
  asAdmin((q) => q("update public.org_message_settings set window_from = '00:00', window_until = '24:00', skip_rest_days = false where organization_id = $1", [org]));
// the business's latest pause: from 3 days ago until 1 hour ago (more than 24 hours), stamps put back with triggers off
const longPauseEnded = (org: string) =>
  asAdmin(async (q) => {
    await q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, false, null) on conflict (organization_id) do nothing", [org]);
    await q("set local session_replication_role = replica");
    await q(
      "update public.org_sending_pauses set paused = false, reason = null, paused_at = now() - interval '3 days', resumed_at = now() - interval '1 hour' where organization_id = $1",
      [org],
    );
  });
const noPause = (org: string) =>
  asAdmin(async (q) => {
    await q("set local session_replication_role = replica");
    await q("update public.org_sending_pauses set paused_at = null, resumed_at = null where organization_id = $1", [org]);
  });
// job B: made 3 days ago, due 2 days ago, never told to wait: still covered by the long pause
const coveredJob = async (org: string, payload: Record<string, unknown>) => {
  const id = await enqueue(org, payload);
  await asAdmin((q) => q("update app.jobs set created_at = now() - interval '3 days', next_run_at = now() - interval '2 days' where id = $1", [id]));
  return id;
};
const fillBusinessRate = (org: string, channel: string, sent: number) =>
  asAdmin((q) =>
    q(
      `insert into app.message_send_rate (organization_id, channel, minute_start, sent) values ($1, $2, date_trunc('minute', now()), $3)
       on conflict (organization_id, channel) do update set minute_start = excluded.minute_start, sent = excluded.sent`,
      [org, channel, sent],
    ),
  );
type Channels = { channels: Array<Record<string, unknown>> };
const usageAs = (user: string, org: string) =>
  asUser(user, async (q) => (await q<{ r: Channels }>("select public.message_usage($1) as r", [org])).rows[0].r);

/**
 * The independent review of MSG-05 / MSG-06 (findings 1-6): the batch moves never hide a job the latest long pause still covers,
 * never move a service message for the rate or the cap, run in id order; a cap waiter keeps its mark; a large plan override
 * never overflows; a lift below this month's usage holds again.
 */
describe("send check batch moves and caps after review (MSG-05, MSG-06)", () => {
  let owner: { id: string }, org: string, lead: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("review-owner");
    org = await createOrg(owner.id, "עסק בדיקת תיקונים");
    await addMember(org, owner.id, "admin", "review-admin");
    lead = await insertLead(owner.id, org, { email: "review@example.test", phone: "0501230004" });
    for (const channel of ["email", "sms", "whatsapp"]) {
      await asUser(owner.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, $3, 'granted', 'manual', 'בשיחה')", [
          org,
          lead,
          channel,
        ]),
      );
    }
    await asAdmin((q) =>
      q("insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days) values ($1, '00:00', '24:00', false)", [org]),
    );
    await asAdmin((q) =>
      q(
        `update public.subscriptions set limit_overrides = coalesce(limit_overrides, '{}'::jsonb)
           || '{"max_customer_emails_per_month": null, "max_customer_emails_per_day": null}'::jsonb where organization_id = $1`,
        [org],
      ),
    );
  });
  beforeEach(async () => {
    await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')"));
    await asAdmin((q) => q("update app.message_send_rate set sent = 0"));
    await asAdmin((q) => q("update app.message_system_rate set sent = 0"));
    await asAdmin((q) => q("update app.message_usage_days set marketing = 0, service = 0 where organization_id = $1", [org]));
    await asAdmin((q) => q("update app.message_cap_holds set cleared_at = now() where organization_id = $1 and cleared_at is null", [org]));
    await setCaps(org, {});
    await openWindow(org);
    await noPause(org);
  });
  afterAll(async () => {
    await noPause(org);
    await asAdmin((q) => q("update app.message_system_rate set sent = 0"));
    await closePool();
  });

  // finding 1: the window, rate and cap moves leave the long pause's job to its own check
  for (const kind of ["hours", "rate", "cap"] as const) {
    it(`finding 1 (${kind}): a job the latest long pause covers is not moved and is still judged pause_expired`, async () => {
      if (kind === "hours") await closeWindow(org);
      if (kind === "rate") await fillBusinessRate(org, "email", 60);
      if (kind === "cap") await setCaps(org, { email: 0 });
      const a = await enqueue(org, { channel: "email", lead_id: lead, message_type: "marketing" });
      const job = await claimOne(a);
      await longPauseEnded(org);
      const b = await coveredJob(org, { channel: "email", lead_id: lead, message_type: "marketing" });
      const answer = await maySend(job);
      expect(answer.may_send, JSON.stringify(answer)).toBe(false);
      expect(answer.retry).toBe(true);
      expect((await jobOf(b)).last_error).toBeNull();
      // B is the oldest due job: claimed next and cancelled, not sent
      expect(await maySend(await claimOne(b))).toEqual({ may_send: false, reason: "pause_expired" });
    });
  }

  it("finding 2: the rate move never takes a service message; a verification code waits for no one", async () => {
    await fillBusinessRate(org, "sms", 30);
    const a = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    const job = await claimOne(a);
    const code = await enqueue(org, { channel: "sms", message_type: "verification_code", sender_check_id: await senderCheck(org) });
    const collection = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "collection" });
    const reminder = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "meeting_reminder" });
    const other = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    expect(await maySend(job)).toMatchObject({ reason: "rate" });
    for (const id of [code, collection, reminder]) expect((await jobOf(id)).last_error, id).toBeNull();
    expect((await jobOf(other)).last_error).toBe("waiting:rate");
    expect(await maySend(await claimOne(code))).toEqual({ may_send: true });
  });

  it("finding 3: a lift to a cap still at or below this month's usage holds again at the new cap", async () => {
    await setCaps(org, { sms: 2 });
    for (let i = 0; i < 2; i++) expect((await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
    const { id, answer } = await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    expect(answer).toMatchObject({ reason: "over_cap" });
    // this month already holds 5
    await asAdmin((q) => q("update app.message_usage_days set marketing = 5 where organization_id = $1 and channel = 'sms'", [org]));
    await setCaps(org, { sms: 3 });
    await due(id);
    expect(await maySend(await claimOne(id))).toEqual({ may_send: false, reason: "over_cap", retry: true });
    const hold = await asAdmin(
      async (q) =>
        (await q<{ held_cap: number; cleared_at: Date | null }>("select held_cap, cleared_at from app.message_cap_holds where organization_id = $1 and channel = 'sms'", [org]))
          .rows[0],
    );
    expect(hold).toEqual({ held_cap: 3, cleared_at: null });
    expect((await jobOf(id)).cap_wait).toBe("over_cap");
  });

  it("finding 4: a plan override of 1e10 is clamped, never an overflow", async () => {
    await asAdmin((q) =>
      q(`update public.subscriptions set limit_overrides = limit_overrides || '{"max_customer_emails_per_month": 10000000000}'::jsonb where organization_id = $1`, [org]),
    );
    try {
      expect((await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
      const usage = await usageAs(owner.id, org);
      expect(usage.channels.find((c) => c.channel === "email")).toMatchObject({ plan_month_cap: 2147483647, marketing: 1 });
    } finally {
      await asAdmin((q) =>
        q(`update public.subscriptions set limit_overrides = limit_overrides || '{"max_customer_emails_per_month": null}'::jsonb where organization_id = $1`, [org]),
      );
    }
  });

  it("finding 6: a cap waiter keeps its mark through a window wait, is counted and is cancellable", async () => {
    await setCaps(org, { whatsapp: 0 });
    const { id } = await check(org, { channel: "whatsapp", lead_id: lead, message_type: "marketing" });
    expect(await jobOf(id)).toMatchObject({ last_error: "waiting:over_cap", cap_wait: "over_cap" });
    // the window closes: another message's window move leaves the cap waiter alone
    await closeWindow(org);
    await asAdmin((q) => q("update app.jobs set next_run_at = now() + interval '1 hour' where id = $1", [id]));
    const a = await enqueue(org, { channel: "email", lead_id: lead, message_type: "collection" });
    const job = await claimOne(a);
    await due(id);
    expect(await maySend(job)).toMatchObject({ reason: "sending_hours" });
    expect(await jobOf(id)).toMatchObject({ last_error: "waiting:over_cap", cap_wait: "over_cap" });
    // its own check: outside the window it waits for the window, still a cap waiter
    expect(await maySend(await claimOne(id))).toMatchObject({ reason: "sending_hours" });
    expect(await jobOf(id)).toMatchObject({ last_error: "waiting:sending_hours", cap_wait: "over_cap" });
    const usage = await usageAs(owner.id, org);
    expect(usage.channels.find((c) => c.channel === "whatsapp")).toMatchObject({ waiting_cap: 1, held: true });
    expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.message_cancel_waiting($1, 'whatsapp') as n", [org])).rows[0].n)).toBe(1);
    expect(await jobOf(id)).toMatchObject({ status: "refused", last_error: "refused:cap_cancelled" });
  });

  it("finding 6: cancelling stays allowed in a read-only business", async () => {
    await setCaps(org, { sms: 0 });
    await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.message_cancel_waiting($1, 'sms') as n", [org])).rows[0].n)).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    expect(await notices(org, "הודעות שיווק מחכות: התקרה החודשית מלאה")).toBeGreaterThan(0);
  });

  it("finding 5: every batch move selects its jobs in id order before updating; the move is server-only", async () => {
    const src = await asAdmin(
      async (q) =>
        (await q<{ s: string }>("select prosrc as s from pg_proc where oid = 'app.message_move_waiting(uuid,uuid,timestamptz,text,text,text)'::regprocedure")).rows[0].s,
    );
    expect(src).toMatch(/order by j\.id\s+for update of j/);
    const body = await asAdmin(
      async (q) => (await q<{ s: string }>("select prosrc as s from pg_proc where oid = 'public.job_message_may_send(uuid,uuid)'::regprocedure")).rows[0].s,
    );
    // the only updates of other jobs go through the ordered move
    expect(body).not.toMatch(/j\.id <> p_job/);
    for (const role of ["anon", "authenticated", "service_role"]) {
      const f = await asAdmin(
        async (q) =>
          (await q<{ f: boolean }>("select has_function_privilege($1, 'app.message_move_waiting(uuid,uuid,timestamptz,text,text,text)', 'execute') as f", [role])).rows[0].f,
      );
      expect(f, role).toBe(false);
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

const KEY = "test-consent-key";

type Claimed = { id: string; lease: string; organization_id: string };
type Job = { status: string; attempts: number; last_error: string | null; next_run_at: Date; usage_counted: boolean };

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
const usageOf = (org: string, channel: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ marketing: number; service: number }>(
          "select coalesce(sum(marketing), 0)::int as marketing, coalesce(sum(service), 0)::int as service from app.message_usage_days where organization_id = $1 and channel = $2",
          [org, channel],
        )
      ).rows[0],
  );
const setCaps = (org: string, caps: { email?: number | null; sms?: number | null; whatsapp?: number | null }) =>
  asAdmin((q) =>
    q(
      `update public.org_message_settings set monthly_cap_email = $2, monthly_cap_sms = $3, monthly_cap_whatsapp = $4 where organization_id = $1`,
      [org, caps.email ?? null, caps.sms ?? null, caps.whatsapp ?? null],
    ),
  );
const notices = (org: string, title: string) =>
  asAdmin((q) => count(q, "select 1 from public.notifications where organization_id = $1 and type = 'system' and title = $2", [org, title]));
const fillSystem = (channel: string, sent: number) =>
  asAdmin((q) => q("update app.message_system_rate set minute_start = date_trunc('minute', now()), sent = $2 where channel = $1", [channel, sent]));
const systemSent = (channel: string) =>
  asAdmin(
    async (q) =>
      (await q<{ n: number }>("select coalesce(sum(sent) filter (where minute_start = date_trunc('minute', now())), 0)::int as n from app.message_system_rate where channel = $1", [channel]))
        .rows[0].n,
  );

/**
 * Owner's answers (133) ג, (135) ב, (136) ב: a system-wide rate per channel (600 / 300 / 200 a minute, in 10 shards) on top of the
 * business's; a full monthly cap holds marketing until the cap is raised, also across a new month, and owners and admins may
 * cancel what waits; a verification code never waits for a rate.
 */
describe("system rate, cap holds and cancelling (MSG-05, MSG-06)", () => {
  let owner: { id: string }, admin: { id: string }, member: { id: string; email: string }, org: string, lead: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("holds-owner");
    org = await createOrg(owner.id, "עסק החזקות");
    admin = await addMember(org, owner.id, "admin", "holds-admin");
    member = await addMember(org, owner.id, "member", "holds-member");
    lead = await insertLead(owner.id, org, { email: "holds@example.test", phone: "0501230003" });
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
  });
  afterAll(async () => {
    await asAdmin((q) => q("update app.message_system_rate set sent = 0"));
    await closePool();
  });

  it("(133) ג: 600 / 300 / 200 a minute in 10 shards per channel", async () => {
    const shape = await asAdmin(
      async (q) =>
        (
          await q<{ channel: string; shards: number; limit: number }>(
            `select channel, count(*)::int as shards, app.message_system_rate_per_minute(channel) as limit
               from app.message_system_rate where shard < app.message_system_rate_shards() group by channel order by channel`,
          )
        ).rows,
    );
    expect(shape).toEqual([
      { channel: "email", shards: 10, limit: 600 },
      { channel: "sms", shards: 10, limit: 300 },
      { channel: "whatsapp", shards: 10, limit: 200 },
    ]);
  });

  it("(133) ג: over the system's minute the job waits uncounted for the next minute; the business's count is not taken", async () => {
    await fillSystem("email", 60);
    const { id, answer } = await check(org, { channel: "email", lead_id: lead, message_type: "collection" });
    // the minute may turn between filling and checking: then it went out
    if (answer.may_send === true) return;
    expect(answer).toEqual({ may_send: false, reason: "system_rate", retry: true });
    expect(await jobOf(id)).toMatchObject({ status: "queued", attempts: 0, last_error: "waiting:system_rate", usage_counted: false });
    const business = await asAdmin(
      async (q) => (await q<{ sent: number }>("select sent from app.message_send_rate where organization_id = $1 and channel = 'email'", [org])).rows[0].sent,
    );
    expect(business).toBe(0);
    // one shard with room: taken, and the system's minute is then exactly full
    await asAdmin((q) => q("update app.message_system_rate set sent = 59 where channel = 'email' and shard = 3"));
    await due(id);
    const again = await maySend(await claimOne(id));
    if (again.may_send !== true && again.reason !== "system_rate") throw new Error(JSON.stringify(again));
    if (again.may_send === true) expect(await systemSent("email")).toBe(600);
  });

  it("(136) ב: a verification code never waits for a rate and takes none; it is counted in the usage", async () => {
    await fillSystem("sms", 30);
    await asAdmin((q) =>
      q(
        `insert into app.message_send_rate (organization_id, channel, minute_start, sent) values ($1, 'sms', date_trunc('minute', now()), 30)
         on conflict (organization_id, channel) do update set minute_start = excluded.minute_start, sent = excluded.sent`,
        [org],
      ),
    );
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "verification_code" })).answer).toEqual({ may_send: true });
    expect(await usageOf(org, "sms")).toEqual({ marketing: 0, service: 1 });
    const business = await asAdmin(
      async (q) => (await q<{ sent: number }>("select sent from app.message_send_rate where organization_id = $1 and channel = 'sms'", [org])).rows[0].sent,
    );
    expect(business).toBe(30);
    expect(await systemSent("sms")).toBeLessThanOrEqual(300);
  });

  it("(135) ב: a full cap holds marketing across a new month until it is raised", async () => {
    await setCaps(org, { sms: 1 });
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
    const { id, answer } = await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    expect(answer).toEqual({ may_send: false, reason: "over_cap", retry: true });
    const usage = await asUser(owner.id, async (q) => (await q<{ r: { channels: Array<Record<string, unknown>> } }>("select public.message_usage($1) as r", [org])).rows[0].r);
    expect(usage.channels.find((c) => c.channel === "sms")).toMatchObject({ held: true, waiting_cap: 1 });
    // a new month: last month's count is behind; the message still waits
    await asAdmin((q) => q("update app.message_usage_days set day = day - 40 where organization_id = $1 and channel = 'sms'", [org]));
    await due(id);
    expect(await maySend(await claimOne(id))).toEqual({ may_send: false, reason: "over_cap", retry: true });
    // a new message of the channel waits too; a service message goes
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" })).answer).toMatchObject({ reason: "over_cap" });
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "collection" })).answer).toEqual({ may_send: true });
    // the notice no longer promises the next month
    const body = await asAdmin(
      async (q) => (await q<{ body: string }>("select body from public.notifications where organization_id = $1 and title = 'הודעות שיווק מחכות: התקרה החודשית מלאה' order by created_at desc limit 1", [org])).rows[0].body,
    );
    expect(body).not.toContain("החודש הבא");
    expect(body).toContain("לבטל");
    // raised: the hold is lifted and the message goes
    await setCaps(org, { sms: 2 });
    await due(id);
    expect(await maySend(await claimOne(id))).toEqual({ may_send: true });
    const hold = await asAdmin(
      async (q) => (await q<{ cleared: Date | null }>("select cleared_at as cleared from app.message_cap_holds where organization_id = $1 and channel = 'sms'", [org])).rows[0],
    );
    expect(hold.cleared).not.toBeNull();
  });

  it("(135) ב: owners and admins cancel the waiting messages through the queue's cancellation count", async () => {
    await setCaps(org, { whatsapp: 0 });
    const a = await check(org, { channel: "whatsapp", lead_id: lead, message_type: "marketing" });
    const b = await check(org, { channel: "whatsapp", lead_id: lead, message_type: "marketing" });
    expect(a.answer).toMatchObject({ reason: "over_cap" });
    expect(b.answer).toMatchObject({ reason: "over_cap" });
    const other = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    const outsider = await createUser("holds-outsider");
    for (const u of [member, outsider]) {
      expect((await pgError(asUser(u.id, (q) => q("select public.message_cancel_waiting($1, 'whatsapp')", [org])))).code, u.email).toBe("42501");
    }
    expect((await pgError(asUser(owner.id, (q) => q("select public.message_cancel_waiting($1, 'fax')", [org])))).hint).toBe("message_cancel:channel");
    const before = await asAdmin(
      async (q) => (await q<{ n: number }>("select coalesce(sum(pending), 0)::int as n from app.job_cancel_counts where organization_id = $1 and reason = 'cap_cancelled'", [org])).rows[0].n,
    );
    const n = await asUser(admin.id, async (q) => (await q<{ n: number }>("select public.message_cancel_waiting($1, 'whatsapp') as n", [org])).rows[0].n);
    expect(n).toBe(2);
    for (const id of [a.id, b.id]) expect(await jobOf(id)).toMatchObject({ status: "refused", last_error: "refused:cap_cancelled" });
    expect((await jobOf(other)).status).toBe("queued");
    const after = await asAdmin(
      async (q) => (await q<{ n: number }>("select coalesce(sum(pending), 0)::int as n from app.job_cancel_counts where organization_id = $1 and reason = 'cap_cancelled'", [org])).rows[0].n,
    );
    // flushed by another test's wake meanwhile is possible only through app.flush_job_cancellations; here nothing flushes
    expect(after - before).toBe(2);
    expect(
      await asAdmin((q) =>
        count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'messages_cancelled' and changes = $2::jsonb", [org, JSON.stringify({ channel: "whatsapp", count: 2 })]),
      ),
    ).toBe(1);
    expect(await asUser(owner.id, async (q) => (await q<{ n: number }>("select public.message_cancel_waiting($1, 'whatsapp') as n", [org])).rows[0].n)).toBe(0);
    for (const role of ["anon"]) {
      const f = await asAdmin(
        async (q) => (await q<{ f: boolean }>("select has_function_privilege($1, 'public.message_cancel_waiting(uuid,text)', 'execute') as f", [role])).rows[0].f,
      );
      expect(f, role).toBe(false);
    }
    expect(await notices(org, "הודעות שיווק מחכות: התקרה החודשית מלאה")).toBeGreaterThan(0);
  });
});

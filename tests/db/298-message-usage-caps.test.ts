import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError, type Query } from "./helpers";

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
const finish = (job: Claimed, ok: boolean) =>
  asService(async (q) => (await q<{ r: string }>("select public.finish_job($1, $2, $3) as r", [job.id, job.lease, ok])).rows[0].r);
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

/**
 * MSG-05, owner 4 November 2026, answers (122) ג, (123) ב, (124) א, (125) ב: messages are counted per business, channel and month;
 * the business's monthly cap and the plan's email quota hold marketing only. A marketing message over them waits, uncounted,
 * and goes once the cap is raised; a service message is never held. The owners and admins are told at 80% and at 100%, then
 * once a day while messages wait.
 */
describe("message usage and caps (MSG-05)", () => {
  let owner: { id: string }, admin: { id: string }, member: { id: string }, org: string, lead: string;

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("caps-owner");
    org = await createOrg(owner.id, "עסק תקרות");
    admin = await addMember(org, owner.id, "admin", "caps-admin");
    member = await addMember(org, owner.id, "member", "caps-member");
    lead = await insertLead(owner.id, org, { email: "caps@example.test", phone: "0501230002" });
    for (const channel of ["email", "sms", "whatsapp"]) {
      await asUser(owner.id, (q) =>
        q("insert into public.consents (organization_id, lead_id, channel, state, source, method) values ($1, $2, $3, 'granted', 'manual', 'בשיחה')", [
          org,
          lead,
          channel,
        ]),
      );
    }
    // these tests are about the caps: any hour, and a plan without an email quota unless a test sets one
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
    await asAdmin((q) => q("update app.message_cap_holds set cleared_at = now() where organization_id = $1 and cleared_at is null", [org]));
    await asAdmin((q) => q("update app.message_usage_days set marketing = 0, service = 0 where organization_id = $1", [org]));
    await asAdmin((q) => q("update app.message_cap_notices set warned_at = null, full_notice_on = null, day_notice_on = null where organization_id = $1", [org]));
    await setCaps(org, {});
  });
  afterAll(() => closePool());

  it("the caps: owners and admins of a writable business set them, 0..10,000,000 or none", async () => {
    expect(await asUser(member.id, async (q) => (await q("update public.org_message_settings set monthly_cap_sms = 5 where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await asUser(admin.id, async (q) => (await q("update public.org_message_settings set monthly_cap_sms = 5 where organization_id = $1", [org])).rowCount)).toBe(1);
    for (const bad of [-1, 10_000_001]) {
      expect((await pgError(asUser(owner.id, (q) => q("update public.org_message_settings set monthly_cap_email = $2 where organization_id = $1", [org, bad])))).code).toBe("23514");
    }
    expect(await asUser(owner.id, async (q) => (await q("update public.org_message_settings set monthly_cap_email = null where organization_id = $1", [org])).rowCount)).toBe(1);
  });

  it("(123) ב: a service message is counted but never held by the cap", async () => {
    await setCaps(org, { sms: 0 });
    for (const type of ["collection", "meeting_reminder", "requested_document", "verification_code"]) {
      // SMS-01b (final review (7)): on sms a verification code is only a sender check's (a check row of the business's phone)
      const target =
        type === "verification_code"
          ? {
              sender_check_id: await asAdmin(
                async (q) => (await q<{ id: string }>("insert into app.sms_sender_checks (organization_id, phone) values ($1, '+972520000000') returning id", [org])).rows[0].id,
              ),
            }
          : { lead_id: lead };
      expect((await check(org, { channel: "sms", message_type: type, ...target })).answer, type).toEqual({ may_send: true });
    }
    expect(await usageOf(org, "sms")).toEqual({ marketing: 0, service: 4 });
  });

  it("(122) ג: marketing over the cap waits uncounted with the channel's other due marketing; a raised cap lets it go", async () => {
    await setCaps(org, { sms: 2 });
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
    expect((await check(org, { channel: "sms", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
    expect(await usageOf(org, "sms")).toEqual({ marketing: 2, service: 0 });
    // 100% reached: one notice to each active owner and admin
    expect(await notices(org, "הודעות שיווק מחכות: התקרה החודשית מלאה")).toBe(2);

    const over = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    const job = await claimOne(over);
    const other = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "marketing" });
    const service = await enqueue(org, { channel: "sms", lead_id: lead, message_type: "collection" });
    const email = await enqueue(org, { channel: "email", lead_id: lead, message_type: "marketing" });
    expect(await maySend(job)).toEqual({ may_send: false, reason: "over_cap", retry: true });
    const waiting = await jobOf(over);
    expect(waiting).toMatchObject({ status: "queued", attempts: 0, last_error: "waiting:over_cap", usage_counted: false });
    expect(waiting.next_run_at.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await jobOf(other)).last_error).toBe("waiting:over_cap");
    expect((await jobOf(service)).last_error).toBeNull();
    expect((await jobOf(email)).last_error).toBeNull();
    expect(await usageOf(org, "sms")).toEqual({ marketing: 2, service: 0 });
    // the same day: no second notice; nothing cancelled
    expect(await notices(org, "הודעות שיווק מחכות: התקרה החודשית מלאה")).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from app.job_cancel_counts where organization_id = $1 and reason = 'over_cap'", [org]))).toBe(0);

    // the owner raises the cap: the waiting message goes on its next check
    await asAdmin((q) => q("update app.jobs set status = 'done' where id = any ($1)", [[other, service, email]]));
    await setCaps(org, { sms: 3 });
    await due(over);
    expect(await maySend(await claimOne(over))).toEqual({ may_send: true });
    expect(await usageOf(org, "sms")).toEqual({ marketing: 3, service: 0 });
  });

  it("a message counted on an earlier try is not counted again and does not wait for the cap", async () => {
    await setCaps(org, { whatsapp: 1 });
    const { id, job, answer } = await check(org, { channel: "whatsapp", lead_id: lead, message_type: "marketing" });
    expect(answer).toEqual({ may_send: true });
    expect(await finish(job, false)).toBe("failed");
    await due(id);
    expect(await maySend(await claimOne(id))).toEqual({ may_send: true });
    expect(await usageOf(org, "whatsapp")).toEqual({ marketing: 1, service: 0 });
  });

  it("80%: one notice a month", async () => {
    await setCaps(org, { whatsapp: 5 });
    for (let i = 0; i < 4; i++) expect((await check(org, { channel: "whatsapp", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
    expect(await notices(org, "הודעות שיווק: 80% מהתקרה החודשית")).toBe(2);
    const body = await asAdmin(
      async (q) => (await q<{ body: string }>("select body from public.notifications where organization_id = $1 and title = 'הודעות שיווק: 80% מהתקרה החודשית' limit 1", [org])).rows[0].body,
    );
    expect(body).toBe("החודש יצאו 4 מתוך 5 הודעות שיווק ב-WhatsApp.");
    expect(body).not.toMatch(/caps@example|050/);
  });

  it("(125) ב: the plan's email quota holds marketing email only; over the daily quota it waits for the next day", async () => {
    await asAdmin((q) =>
      q(`update public.subscriptions set limit_overrides = limit_overrides || '{"max_customer_emails_per_month": 1}'::jsonb where organization_id = $1`, [org]),
    );
    try {
      expect((await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
      expect((await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: false, reason: "over_cap", retry: true });
      expect(await notices(org, "הודעות שיווק מחכות: מכסת האימייל של החבילה מלאה")).toBe(2);
      // a service email is not counted in the plan's quota
      expect((await check(org, { channel: "email", lead_id: lead, message_type: "collection" })).answer).toEqual({ may_send: true });

      await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')"));
      await asAdmin((q) => q("update app.message_usage_days set marketing = 0 where organization_id = $1", [org]));
      await asAdmin((q) =>
        q(
          `update public.subscriptions set limit_overrides = limit_overrides || '{"max_customer_emails_per_month": null, "max_customer_emails_per_day": 1}'::jsonb where organization_id = $1`,
          [org],
        ),
      );
      expect((await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
      // The wait is greatest(start of the business's next day, now() + 1 minute): within the last minute before midnight in
      // the business zone it is now() + 1 minute. The check's now() lies between these two reads, and the rule only grows.
      const waitAt = (q: Query) =>
        q<{ w: Date }>(
          "select greatest(((now() at time zone 'Asia/Jerusalem')::date + 1)::timestamp at time zone 'Asia/Jerusalem', now() + interval '1 minute') as w",
        ).then((r) => r.rows[0].w.getTime());
      const earliest = await asAdmin(waitAt);
      const { id, answer } = await check(org, { channel: "email", lead_id: lead, message_type: "marketing" });
      expect(answer).toEqual({ may_send: false, reason: "day_quota", retry: true });
      const latest = await asAdmin(waitAt);
      const waited = (await jobOf(id)).next_run_at.getTime();
      expect(waited).toBeGreaterThanOrEqual(earliest);
      expect(waited).toBeLessThanOrEqual(latest);
      expect(await notices(org, "אימיילים שיווקיים מחכים למחר")).toBe(2);
    } finally {
      await asAdmin((q) =>
        q(
          `update public.subscriptions set limit_overrides = limit_overrides || '{"max_customer_emails_per_month": null, "max_customer_emails_per_day": null}'::jsonb where organization_id = $1`,
          [org],
        ),
      );
    }
  });

  it("(52): a waiting message whose event passed is cancelled and counted", async () => {
    await setCaps(org, { sms: 0 });
    const soon = new Date(Date.now() + 10 * 60_000).toISOString();
    const { id, answer } = await check(org, { channel: "sms", lead_id: lead, message_type: "marketing", event_at: soon });
    expect(answer).toMatchObject({ reason: "over_cap" });
    const passed = new Date(Date.now() - 60_000).toISOString();
    await asAdmin((q) => q("update app.jobs set payload = jsonb_set(payload, '{event_at}', to_jsonb($2::text)), next_run_at = now() where id = $1", [id, passed]));
    expect(await maySend(await claimOne(id))).toEqual({ may_send: false, reason: "event_passed" });
  });

  it("the usage screen: owners and admins get counts only; anyone else gets allowed: false", async () => {
    await setCaps(org, { email: 100 });
    expect((await check(org, { channel: "email", lead_id: lead, message_type: "marketing" })).answer).toEqual({ may_send: true });
    const answer = await asUser(owner.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.message_usage($1) as r", [org])).rows[0].r);
    expect(answer).toMatchObject({ allowed: true });
    const email = (answer.channels as Array<Record<string, unknown>>).find((c) => c.channel === "email");
    expect(email).toMatchObject({ marketing: 1, business_cap: 100, plan_month_cap: null, waiting_cap: 0 });
    expect(Object.keys(email ?? {}).sort()).toEqual(
      ["business_cap", "channel", "held", "marketing", "marketing_today", "plan_day_cap", "plan_month_cap", "service", "waiting_cap", "waiting_hours"].sort(),
    );
    const outsider = await createUser("caps-outsider");
    for (const u of [member, outsider]) {
      expect(await asUser(u.id, async (q) => (await q<{ r: unknown }>("select public.message_usage($1) as r", [org])).rows[0].r)).toEqual({ allowed: false });
    }
    for (const role of ["anon", "service_role"]) {
      const rights = await asAdmin(
        async (q) =>
          (
            await q<{ f: boolean; u: boolean; n: boolean }>(
              `select has_function_privilege($1, 'public.message_usage(uuid)', 'execute') as f,
                      has_table_privilege($1, 'app.message_usage_days', 'select,insert,update,delete') as u,
                      has_table_privilege($1, 'app.message_cap_notices', 'select,insert,update,delete') as n`,
              [role],
            )
          ).rows[0],
      );
      expect(rights, role).toEqual({ f: role === "service_role", u: false, n: false });
    }
  });
});

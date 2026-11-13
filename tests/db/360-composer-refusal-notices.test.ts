import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asAdmin, asService, closePool, createOrg, createUser } from "./helpers";

// RVW-89 (weekly review of 13 November 2026): a business with no address in its document settings cannot send a marketing
// SMS (the marketing envelope's {כתובת העסק} stays empty, the composer refuses 'unfilled_field'). The worker ends the job
// with no provider and that code; app.jobs_record_message (021267) now tells the active owners and admins, once per
// template, reason and business day, as it did for 'too_long'. A consent refusal tells no one.

const KEY = "test-consent-key";
const SITE = "https://mexuz.test";

type Claimed = { id: string; lease: string };
type Answer = Record<string, unknown>;

const FEATURES = { sms: true, review_requests: true };

const prepared = async (org: string, payload: Answer): Promise<Claimed> => {
  const id = await asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2::jsonb, null) as id", [org, JSON.stringify(payload)])).rows[0].id);
  const rows = await asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 100) as r")).rows[0].r);
  const job = rows.find((r) => r.id === id);
  expect(job, "claimed").toBeDefined();
  await asAdmin((q) => q("update app.jobs set send_checked_lease = lease_id, usage_counted = true where id = $1", [id]));
  return job as Claimed;
};
const compose = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Answer }>("select public.sms_job_compose($1, $2, $3) as r", [job.id, job.lease, SITE])).rows[0].r);
/** What the worker does with a final composer refusal (send-handler.ts): failed, final, no provider, the composer's code. */
const finishRefused = (job: Claimed, code: string) =>
  asService((q) => q("select public.finish_job($1, $2, false, $3, true, true, null, null, $4)", [job.id, job.lease, `refused ${code}`, code]));

describe("RVW-89: a composer refusal the business can fix tells its owners", () => {
  let owner: { id: string };
  let org: string;
  let contact: string;
  let template: string;

  const notices = () =>
    asAdmin(
      async (q) =>
        (
          await q<{ user_id: string; body: string; entity_id: string | null }>(
            "select user_id, body, entity_id from public.notifications where organization_id = $1 and type = 'system' and title = 'הודעה ללקוח לא נשלחה' order by created_at",
            [org],
          )
        ).rows,
    );
  const reviewJob = async () => {
    const request = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into app.review_requests (organization_id, source_kind, source_id, contact_id, outcome, channel) values ($1, 'deal', gen_random_uuid(), $2, 'pending', 'sms') returning id",
            [org, contact],
          )
        ).rows[0].id,
    );
    const job = await prepared(org, { channel: "sms", message_type: "review_request", template_id: template, contact_id: contact, review_request_id: request });
    await asAdmin((q) => q("update app.review_requests set job_id = $2, outcome = 'queued' where id = $1", [request, job.id]));
    return job;
  };

  beforeAll(async () => {
    await asAdmin((q) =>
      q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
    );
    owner = await createUser("rvw89-owner");
    org = await createOrg(owner.id, "עסק בלי כתובת");
    await asAdmin(async (q) => {
      await q(
        `update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || $2::jsonb,
                limit_overrides = coalesce(limit_overrides, '{}'::jsonb) || '{"max_sms_per_month": 100000}'::jsonb
          where organization_id = $1`,
        [org, JSON.stringify(FEATURES)],
      );
      // a phone, but no address line or city in the document settings
      await q("update public.organizations set phone = '03-5550000' where id = $1", [org]);
      await q(
        `insert into public.review_request_settings (organization_id, enabled, review_url) values ($1, true, 'https://g.page/r/abc/review')
         on conflict (organization_id) do update set enabled = true, review_url = excluded.review_url`,
        [org],
      );
    });
    contact = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.contacts (organization_id, first_name, last_name, phone, owner_id) values ($1, 'דנה', 'כהן', '052-2220089', $2) returning id",
            [org, owner.id],
          )
        ).rows[0].id,
    );
    await asAdmin((q) =>
      q("insert into public.consents (organization_id, contact_id, channel, state, source, method) values ($1, $2, 'sms', 'granted', 'manual', 'בשיחה')", [org, contact]),
    );
    template = await asAdmin(
      async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.message_templates (organization_id, name, channel, message_type, body, is_active, notice_kind)
             values ($1, 'בקשת ביקורת בדיקה', 'sms', 'review_request', '{שם פרטי}, נשמח לביקורת: {קישור לביקורת}', true, 'review_request') returning id`,
            [org],
          )
        ).rows[0].id,
    );
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(closePool);

  it("a review request in a business with no address is refused 'unfilled_field', and the owner is told once a day", async () => {
    const job = await reviewJob();
    expect(await compose(job)).toEqual({ refused: "unfilled_field" });
    await finishRefused(job, "unfilled_field");
    const message = await asAdmin(
      async (q) =>
        (await q<{ status: string; provider: string | null; provider_error_code: string }>("select status, provider, provider_error_code from public.messages where job_id = $1", [job.id]))
          .rows[0],
    );
    expect(message).toEqual({ status: "failed", provider: null, provider_error_code: "unfilled_field" });
    const told = await notices();
    expect(told).toHaveLength(1);
    expect(told[0].user_id).toBe(owner.id);
    expect(told[0].entity_id).toBe(template);
    expect(told[0].body).toContain('ההודעה מהתבנית "בקשת ביקורת בדיקה" לא נשלחה');
    expect(told[0].body).toContain("כתובת העסק או הטלפון חסרים בהגדרות המסמכים");
    expect(told[0].body).toContain('במע"מ ופרטים למסמכים');

    // a second refusal the same business day tells no one again
    const again = await reviewJob();
    expect(await compose(again)).toEqual({ refused: "unfilled_field" });
    await finishRefused(again, "unfilled_field");
    expect(await notices()).toHaveLength(1);
  });

  it("a consent refusal is about one customer and tells no one; a provider's own failure neither", async () => {
    await asAdmin((q) => q("delete from app.message_refusal_notices where organization_id = $1", [org]));
    const before = (await notices()).length;
    const job = await reviewJob();
    await finishRefused(job, "consent_missing");
    const provider = await reviewJob();
    await asService((q) => q("select public.finish_job($1, $2, false, 'x', true, true, 'inforu', null, 'unfilled_field')", [provider.id, provider.lease]));
    expect(await notices()).toHaveLength(before);
  });

  it("names a reason for each setup refusal and a fix where it is", async () => {
    const texts = await asAdmin(
      async (q) =>
        (
          await q<{ reason: string; t: string | null }>(
            "select r as reason, app.message_send_refusal_text(r) as t from unnest(array['unfilled_field','feature_off','link_blocked','link_invalid','consent_missing']) r",
          )
        ).rows,
    );
    expect(Object.fromEntries(texts.map((r) => [r.reason, r.t !== null]))).toEqual({
      unfilled_field: true,
      feature_off: true,
      link_blocked: true,
      link_invalid: true,
      consent_missing: false,
    });
  });
});

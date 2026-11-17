import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asAdmin, asService, closePool, createOrg, createUser, insertLead } from "./helpers";

// Owner (399) א, 17 November 2026 (RVW-105, ADM-03): during the 30-day deletion wait a customer message WAITS (uncounted,
// 'waiting:org_deletion'), like HEB-09's pause, and goes out when the deletion is cancelled; every other reason a business
// cannot write is still refused; a purge takes the waiting jobs with the business (app.jobs cascades).
const KEY = "test-consent-key";
const setKey = () =>
  asAdmin((q) =>
    q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [KEY]),
  );

type Claimed = { id: string; lease: string; organization_id: string };
const enqueue = (org: string, payload: Record<string, unknown>) =>
  asAdmin(
    async (q) =>
      (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2, null) as id", [org, JSON.stringify({ message_type: "collection", ...payload })]))
        .rows[0].id,
  );
const claim = () => asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs($1, 20) as r", [["message.send"]])).rows[0].r);
const anyHour = (org: string) =>
  asAdmin(async (q) => {
    await q(
      `insert into public.org_message_settings (organization_id, window_from, window_until, skip_rest_days)
       values ($1, '00:00', '24:00', false)
       on conflict (organization_id) do update set window_from = excluded.window_from, window_until = excluded.window_until, skip_rest_days = false`,
      [org],
    );
    await q("update app.message_send_rate set sent = 0 where organization_id = $1", [org]);
    await q("update app.message_system_rate set sent = 0");
  });
const maySend = async (job: Claimed) => {
  await anyHour(job.organization_id);
  return asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
};
const jobOf = (id: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ status: string; attempts: number; last_error: string | null; lease_id: string | null; usage_counted: boolean; wait_min: number }>(
          "select status, attempts, last_error, lease_id, usage_counted, round(extract(epoch from next_run_at - now()) / 60)::int as wait_min from app.jobs where id = $1",
          [id],
        )
      ).rows[0],
  );
const startDeletion = (org: string, by: string) =>
  asAdmin((q) =>
    q(
      `insert into app.org_deletions (organization_id, requested_by, requested_at, confirmed_at, scheduled_for)
       values ($1, $2, now(), now(), now() + interval '30 days')`,
      [org, by],
    ),
  );
const cancelDeletion = (org: string) =>
  asAdmin((q) => q("update app.org_deletions set cancelled_at = now() where organization_id = $1 and cancelled_at is null", [org]));

describe("customer messages during the deletion wait (ADM-03, owner (399) א)", () => {
  let owner: { id: string }, org: string, orgB: string;

  beforeAll(async () => {
    await setKey();
    owner = await createUser("del-msg-owner");
    org = await createOrg(owner.id, "עסק בהמתנה למחיקה");
    orgB = await createOrg(owner.id, "עסק מושעה בהמתנה");
  });
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await cancelDeletion(org);
    await cancelDeletion(orgB);
    await closePool();
  });

  it("the helper is true only for the deletion wait, and no client role may call it", async () => {
    const r = await asAdmin(
      async (q) =>
        (
          await q<{ w: boolean; anon: boolean; auth: boolean; svc: boolean }>(
            `select app.org_deletion_waiting($1) as w,
                    has_function_privilege('anon', 'app.org_deletion_waiting(uuid)', 'execute') as anon,
                    has_function_privilege('authenticated', 'app.org_deletion_waiting(uuid)', 'execute') as auth,
                    has_function_privilege('service_role', 'app.org_deletion_waiting(uuid)', 'execute') as svc`,
            [org],
          )
        ).rows[0],
    );
    expect(r).toEqual({ w: false, anon: false, auth: false, svc: false });
  });

  it("a message waits uncounted while the deletion waits, and goes out at once when the deletion is cancelled", async () => {
    const lead = await insertLead(owner.id, org, { email: "wait-delete@example.test" });
    await startDeletion(org, owner.id);
    try {
      const id = await enqueue(org, { channel: "email", lead_id: lead });
      const [job] = await claim();
      expect(job.id).toBe(id);
      expect(await maySend(job)).toEqual({ may_send: false, reason: "org_deletion", retry: true });
      expect(await jobOf(id)).toMatchObject({ status: "queued", attempts: 0, lease_id: null, last_error: "waiting:org_deletion", usage_counted: false, wait_min: 15 });
      expect(await claim()).toEqual([]);

      // an event that passed is still refused during the wait
      const past = await enqueue(org, { channel: "email", lead_id: lead, event_at: new Date(Date.now() + 60_000).toISOString() });
      await asAdmin((q) => q("update app.jobs set payload = jsonb_set(payload, '{event_at}', to_jsonb($2::text)) where id = $1", [past, new Date(Date.now() - 60_000).toISOString()]));
      const [p] = await claim();
      expect(p.id).toBe(past);
      expect(await maySend(p)).toEqual({ may_send: false, reason: "event_passed" });
    } finally {
      await cancelDeletion(org);
    }
    // the cancel makes the waiting job due now; it is claimed and may send
    const waiting = await asAdmin(
      async (q) => (await q<{ id: string; due: boolean }>("select id, next_run_at <= now() as due from app.jobs where organization_id = $1 and last_error = 'waiting:org_deletion'", [org])).rows,
    );
    expect(waiting.length).toBe(1);
    expect(waiting[0].due).toBe(true);
    const [again] = await claim();
    expect(again.id).toBe(waiting[0].id);
    expect(await maySend(again)).toEqual({ may_send: true });
  });

  it("a business that cannot write for another reason is still refused, deletion wait or not", async () => {
    const lead = await insertLead(owner.id, orgB, { email: "closed-delete@example.test" });
    await startDeletion(orgB, owner.id);
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [orgB]));
    try {
      const id = await enqueue(orgB, { channel: "email", lead_id: lead });
      const [job] = await claim();
      expect(await maySend(job)).toEqual({ may_send: false, reason: "business_closed" });
      expect((await jobOf(id)).status).toBe("refused");
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [orgB]));
      await cancelDeletion(orgB);
    }
  });

  it("the composers answer 'paused' (tried again, count given back) for a deletion confirmed after the send check", async () => {
    await asAdmin((q) =>
      q(`update public.subscriptions set feature_overrides = coalesce(feature_overrides, '{}'::jsonb) || '{"sms": true}'::jsonb where organization_id = $1`, [org]),
    );
    const lead = await insertLead(owner.id, org, { email: "compose-delete@example.test", phone: "0501234567" });
    for (const channel of ["email", "sms"] as const) {
      const id = await enqueue(org, { channel, lead_id: lead });
      const [job] = await claim();
      expect(job.id).toBe(id);
      expect(await maySend(job)).toEqual({ may_send: true });
      await startDeletion(org, owner.id);
      try {
        const answer = await asService(
          async (q) =>
            (await q<{ r: Record<string, unknown> }>(`select public.${channel}_job_compose($1, $2, 'https://crm.example.test') as r`, [job.id, job.lease])).rows[0].r,
        );
        expect(answer, channel).toEqual({ refused: "paused" });
      } finally {
        await cancelDeletion(org);
      }
      await asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where id = $1", [id]));
    }
  });

  it("a purge at the end of the wait takes the waiting jobs with the business (app.jobs cascades)", async () => {
    const del = await asAdmin(
      async (q) =>
        (
          await q<{ d: string }>(
            `select c.confdeltype::text as d from pg_constraint c
              where c.conrelid = 'app.jobs'::regclass and c.contype = 'f' and c.confrelid = 'public.organizations'::regclass`,
          )
        ).rows,
    );
    expect(del).toEqual([{ d: "c" }]);
  });
});

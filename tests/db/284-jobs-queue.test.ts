import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asService, asUser, closePool, createOrg, createUser, insertLead, pgError, TEST_DB_URL } from "./helpers";

// the owner fills app.settings 'consent_hash_key' per environment; the tests use their own
const KEY = "test-consent-key";
const setKey = (value: string | null) =>
  asAdmin((q) =>
    value === null
      ? q("update app.settings set value = '' where key = 'consent_hash_key'")
      : q("insert into app.settings (key, value) values ('consent_hash_key', $1) on conflict (key) do update set value = excluded.value", [value]),
  );

type Claimed = { id: string; lease: string; kind: string; organization_id: string; payload: Record<string, unknown>; attempt: number };
type Job = { status: string; attempts: number; last_error: string | null; next_run_at: Date; lease_id: string | null; locked_until: Date | null };

const enqueue = (org: string, payload: Record<string, unknown>, runAt: string | null = null) =>
  asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2, $3) as id", [org, JSON.stringify(payload), runAt])).rows[0].id);
const claim = (limit = 20, kinds = ["message.send"]) =>
  asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs($1, $2) as r", [kinds, limit])).rows[0].r);
const finish = (job: Claimed | { id: string; lease: string }, ok: boolean, error: string | null = null, final = false) =>
  asService(async (q) => (await q<{ r: string }>("select public.finish_job($1, $2, $3, $4, $5) as r", [job.id, job.lease, ok, error, final])).rows[0].r);
const maySend = (job: Claimed) =>
  asService(async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r);
const jobOf = (id: string) => asAdmin(async (q) => (await q<Job>("select * from app.jobs where id = $1", [id])).rows[0]);
const due = (id: string) => asAdmin((q) => q("update app.jobs set next_run_at = now() - interval '1 second' where id = $1", [id]));

/**
 * OPS-04: the background job queue (owner's answer (א): in the database, a worker route the database wakes). Claims are
 * fair per business and skip locked rows; a lease guards each claim; failures back off and end dead; the send check
 * refuses while the business paused sending (HEB-09) or the address is suppressed (consents), without personal data.
 */
describe("background job queue (OPS-04)", () => {
  let owner: { id: string }, org: string, orgB: string, orgC: string;
  const send = (lead: string) => ({ channel: "email", lead_id: lead });

  beforeAll(async () => {
    await setKey(KEY);
    owner = await createUser("jobs-owner");
    org = await createOrg(owner.id, "עסק תור");
    orgB = await createOrg(owner.id, "עסק תור ב");
    orgC = await createOrg(owner.id, "עסק תור ג");
  });
  // every test starts from an empty queue (other tests' jobs would be claimed too)
  beforeEach(() => asAdmin((q) => q("update app.jobs set status = 'done', lease_id = null, locked_until = null where status in ('queued', 'failed', 'running')")));
  afterAll(async () => {
    await setKey(KEY);
    await closePool();
  });

  it("no client role touches app.jobs or calls the queue functions; service_role only claims, finishes and checks", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const rights = await asAdmin(
        async (q) =>
          (
            await q<{ t: boolean; enqueue: boolean; wake: boolean }>(
              `select has_table_privilege($1, 'app.jobs', 'select,insert,update,delete') as t,
                      has_function_privilege($1, 'app.enqueue_job(uuid,text,jsonb,timestamptz)', 'execute') as enqueue,
                      has_function_privilege($1, 'app.wake_job_worker()', 'execute') as wake`,
              [role],
            )
          ).rows[0],
      );
      expect(rights, role).toEqual({ t: false, enqueue: false, wake: false });
      const publics = await asAdmin(
        async (q) =>
          (
            await q<{ c: boolean; f: boolean; m: boolean }>(
              `select has_function_privilege($1, 'public.claim_jobs(text[],integer,integer)', 'execute') as c,
                      has_function_privilege($1, 'public.finish_job(uuid,uuid,boolean,text,boolean)', 'execute') as f,
                      has_function_privilege($1, 'public.job_message_may_send(uuid,uuid)', 'execute') as m`,
              [role],
            )
          ).rows[0],
      );
      const allowed = role === "service_role";
      expect(publics, role).toEqual({ c: allowed, f: allowed, m: allowed });
    }
    expect((await pgError(asUser(owner.id, (q) => q("select public.claim_jobs(array['message.send'])")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.claim_jobs(array['message.send'])")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.jobs")))).code).toBe("42501");
    expect((await pgError(asService((q) => q("select * from app.jobs")))).code).toBe("42501");
    const rls = await asAdmin(async (q) => (await q<{ r: boolean }>("select relrowsecurity as r from pg_class where oid = 'app.jobs'::regclass")).rows[0].r);
    expect(rls).toBe(true);
  });

  it("payloads hold ids and codes only; unknown kinds are refused", async () => {
    const lead = randomUUID();
    for (const bad of [
      { channel: "email", lead_id: lead, body: "שלום דני" },
      { channel: "email", lead_id: lead, contact_id: randomUUID() },
      { channel: "fax", lead_id: lead },
      { channel: "email", lead_id: "dani@example.com" },
      { channel: "email" },
      [lead],
    ]) {
      const error = await pgError(enqueue(org, bad as Record<string, unknown>));
      expect(error.hint, JSON.stringify(bad)).toBe("job:payload");
    }
    expect((await pgError(asAdmin((q) => q("select app.enqueue_job($1, 'import.run', '{}'::jsonb)", [org]))))).toMatchObject({ hint: "job:kind" });
    // the table refuses a direct write of personal text too
    const direct = await pgError(
      asAdmin((q) => q("insert into app.jobs (organization_id, kind, payload) values ($1, 'message.send', $2)", [org, JSON.stringify({ channel: "sms", lead_id: lead, phone: "0501234567" })])),
    );
    expect(direct.code).toBe("23514");
    const ok = await enqueue(org, { channel: "sms", contact_id: lead });
    expect((await jobOf(ok)).status).toBe("queued");
  });

  it("a job is claimed once, with a lease; a future job waits; an unknown or empty kind list claims nothing", async () => {
    const now = await enqueue(org, send(randomUUID()));
    const later = await enqueue(org, send(randomUUID()), new Date(Date.now() + 3_600_000).toISOString());
    expect(await claim(20, [])).toEqual([]);
    expect(await claim(20, ["other.kind"])).toEqual([]);
    const first = await claim();
    expect(first.map((j) => j.id)).toEqual([now]);
    expect(first[0]).toMatchObject({ kind: "message.send", organization_id: org, attempt: 1 });
    expect(first[0].lease).toMatch(/^[0-9a-f-]{36}$/);
    expect(await claim()).toEqual([]);
    const row = await jobOf(now);
    expect(row.status).toBe("running");
    expect(row.locked_until).not.toBeNull();
    expect((await jobOf(later)).status).toBe("queued");
  });

  it("two workers at once never take the same job (FOR UPDATE SKIP LOCKED)", async () => {
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await enqueue(org, send(randomUUID())));
    const holder = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("set local role service_role");
      const a = (await holder.query<{ r: Claimed[] }>("select public.claim_jobs(array['message.send'], 3) as r")).rows[0].r;
      expect(a).toHaveLength(3);
      // the first claim is not committed yet: the second worker skips its locked rows
      const b = await claim(10);
      expect(b).toHaveLength(3);
      expect(new Set([...a, ...b].map((j) => j.id)).size).toBe(6);
      await holder.query("commit");
    } finally {
      await holder.end();
    }
    expect(await claim(10)).toEqual([]);
  });

  it("is fair per business: each business's first job, then each one's second", async () => {
    for (let i = 0; i < 10; i++) await enqueue(org, send(randomUUID()));
    await enqueue(orgB, send(randomUUID()));
    await enqueue(orgB, send(randomUUID()));
    await enqueue(orgC, send(randomUUID()));
    const got = await claim(6);
    const per = (o: string) => got.filter((j) => j.organization_id === o).length;
    expect([per(org), per(orgB), per(orgC)]).toEqual([3, 2, 1]);
    // the first three claimed are one per business
    expect(new Set(got.slice(0, 3).map((j) => j.organization_id)).size).toBe(3);
  });

  it("only the live lease finishes a job; a lease that ran out is claimed again with a new lease", async () => {
    const id = await enqueue(org, send(randomUUID()));
    const [first] = await claim();
    expect(await finish({ id, lease: randomUUID() }, true)).toBe("stale");
    // the lease runs out: another worker takes the job
    await asAdmin((q) => q("update app.jobs set locked_until = now() - interval '1 second' where id = $1", [id]));
    const [second] = await claim();
    expect(second.id).toBe(id);
    expect(second.attempt).toBe(2);
    expect(second.lease).not.toBe(first.lease);
    // the first worker comes back late: refused
    expect(await finish(first, true)).toBe("stale");
    expect(await finish(second, true)).toBe("done");
    const row = await jobOf(id);
    expect(row).toMatchObject({ status: "done", lease_id: null, locked_until: null, last_error: null });
    expect(await finish(second, true)).toBe("stale");
  });

  it("a failure backs off (1, 4, 16, 64 minutes), and the fifth failed try is dead", async () => {
    const id = await enqueue(org, send(randomUUID()));
    const waits: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const [job] = await claim();
      expect(job.attempt).toBe(attempt);
      const before = Date.now();
      expect(await finish(job, false, "provider said no")).toBe("failed");
      const row = await jobOf(id);
      expect(row.status).toBe("failed");
      waits.push(Math.round((row.next_run_at.getTime() - before) / 60_000));
      // not claimable before its time
      expect(await claim()).toEqual([]);
      await due(id);
    }
    expect(waits).toEqual([1, 4, 16, 64]);
    const [last] = await claim();
    expect(last.attempt).toBe(5);
    expect(await finish(last, false, "still no")).toBe("dead");
    expect(await jobOf(id)).toMatchObject({ status: "dead", last_error: "still no" });
    expect(await claim()).toEqual([]);
    const cap = await asAdmin(async (q) => (await q<{ i: string }>("select app.job_backoff(20)::text as i")).rows[0].i);
    expect(cap).toBe("06:00:00");
  });

  it("final ends a job at once; a lease that ran out on the last try is dead; errors are redacted", async () => {
    const id = await enqueue(org, send(randomUUID()));
    const [job] = await claim();
    expect(await finish(job, false, "bad request for dani@example.com at 050-123-4567", true)).toBe("dead");
    const row = await jobOf(id);
    expect(row.status).toBe("dead");
    expect(row.last_error).not.toMatch(/dani|example|4567/);
    expect(row.last_error).toContain("[email]");
    expect(row.last_error).toContain("[number]");

    const id2 = await enqueue(org, send(randomUUID()));
    await asAdmin((q) => q("update app.jobs set attempts = 4 where id = $1", [id2]));
    const [job2] = await claim();
    expect(job2.attempt).toBe(5);
    await asAdmin((q) => q("update app.jobs set locked_until = now() - interval '1 second' where id = $1", [id2]));
    expect(await claim()).toEqual([]);
    expect(await jobOf(id2)).toMatchObject({ status: "dead", last_error: "lease expired" });
    expect(await finish(job2, true)).toBe("stale");
  });

  it("the send check refuses while sending is paused (HEB-09) and ends the job", async () => {
    const lead = await insertLead(owner.id, org, { email: "pause@example.test" });
    await asUser(owner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [org]));
    try {
      const id = await enqueue(org, send(lead));
      const [job] = await claim();
      expect(await maySend(job)).toEqual({ may_send: false, reason: "sending_paused" });
      expect(await jobOf(id)).toMatchObject({ status: "refused", last_error: "refused:sending_paused", lease_id: null });
      // nothing is sent for it later: the lease is gone
      expect(await finish(job, true)).toBe("stale");
      expect(await claim()).toEqual([]);
    } finally {
      await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    }
  });

  it("the send check refuses a suppressed address, and an address it cannot check; it never answers personal data", async () => {
    const listed = await insertLead(owner.id, org, { email: "listed@example.test", phone: "0501112233" });
    const clean = await insertLead(owner.id, org, { email: "clean@example.test", phone: "0504445566" });
    await asUser(owner.id, (q) => q("select public.consent_blocklist_add($1, 'all', array['listed@example.test'], 'person_request')", [org]));

    const blocked = await enqueue(org, send(listed));
    const [b] = await claim();
    expect(b.id).toBe(blocked);
    expect(await maySend(b)).toEqual({ may_send: false, reason: "consent_suppressed" });
    expect((await jobOf(blocked)).last_error).toBe("refused:consent_suppressed");

    const ok = await enqueue(org, { channel: "sms", lead_id: clean });
    const [c] = await claim();
    const answer = await maySend(c);
    expect(answer).toEqual({ may_send: true });
    expect(JSON.stringify(answer)).not.toMatch(/clean|example|0504/);
    expect((await jobOf(ok)).status).toBe("running");
    expect(await finish(c, true)).toBe("done");

    // without the consent key nothing can be checked: refused (fail closed)
    await setKey(null);
    try {
      const unknown = await enqueue(org, send(clean));
      const [u] = await claim();
      expect(await maySend(u)).toEqual({ may_send: false, reason: "consent_unknown" });
      expect((await jobOf(unknown)).status).toBe("refused");
    } finally {
      await setKey(KEY);
    }
  });

  it("the send check refuses a gone record, a missing address and a closed business; a stale lease changes nothing", async () => {
    const noEmail = await insertLead(owner.id, org, { phone: "0507778899" });
    const gone = await enqueue(org, send(randomUUID()));
    const [g] = await claim();
    expect(await maySend(g)).toEqual({ may_send: false, reason: "record_gone" });
    expect((await jobOf(gone)).status).toBe("refused");

    // another business's lead is "gone" for this business's job
    const other = await insertLead(owner.id, orgB, { email: "other@example.test" });
    await enqueue(org, send(other));
    const [x] = await claim();
    expect(await maySend(x)).toEqual({ may_send: false, reason: "record_gone" });

    const missing = await enqueue(org, send(noEmail));
    const [m] = await claim();
    expect(await maySend({ ...m, lease: randomUUID() })).toEqual({ may_send: false, reason: "stale" });
    expect((await jobOf(missing)).status).toBe("running");
    expect(await maySend(m)).toEqual({ may_send: false, reason: "no_address" });

    const lead = await insertLead(owner.id, orgC, { email: "closed@example.test" });
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [orgC]));
    await enqueue(orgC, send(lead));
    const [s] = await claim();
    expect(await maySend(s)).toEqual({ may_send: false, reason: "business_closed" });
  });

  it("the worker is woken only with its settings, pg_net and due work; the cron job is registered where pg_cron exists", async () => {
    // locally there is no pg_net: never woken
    await enqueue(org, send(randomUUID()));
    const woke = await asAdmin(async (q) => (await q<{ w: boolean }>("select app.wake_job_worker() as w")).rows[0].w);
    expect(woke).toBe(false);
    const src = await asAdmin(async (q) => (await q<{ s: string }>("select prosrc as s from pg_proc where oid = 'app.wake_job_worker()'::regprocedure")).rows[0].s);
    expect(src).toContain("'jobs_run_url'");
    expect(src).toContain("'/api/jobs/run'");
    expect(src).toContain("'push_dispatch_secret'");
    const job = await asAdmin(async (q) => {
      const has = (await q<{ n: number }>("select count(*)::int as n from pg_extension where extname = 'pg_cron'")).rows[0].n;
      return has ? (await q<{ command: string }>("select command from cron.job where jobname = 'crm-jobs-wake'")).rows[0]?.command : "no pg_cron";
    });
    expect(["select app.wake_job_worker();", "no pg_cron"]).toContain(job);
  });
});

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

// md5 of the worker's three functions as reviewed: body, security definer, settings and arguments (see the (55) test)
const REVIEWED_MD5 = {
  claim_jobs: "de918761f4f48c2c50254db26f65011f",
  finish_job: "50078fb665234f8655dd361ef51ceefb",
  job_message_may_send: "7d7702499878eebf9044debdbc85d7b0",
};

type Claimed = { id: string; lease: string; kind: string; organization_id: string; payload: Record<string, unknown>; attempt: number };
type Job = { status: string; attempts: number; last_error: string | null; next_run_at: Date; lease_id: string | null; locked_until: Date | null };

const enqueue = (org: string, payload: Record<string, unknown>, runAt: string | null = null) =>
  asAdmin(async (q) => (await q<{ id: string }>("select app.enqueue_job($1, 'message.send', $2, $3) as id", [org, JSON.stringify(payload), runAt])).rows[0].id);
const claim = (limit = 20, kinds = ["message.send"]) =>
  asService(async (q) => (await q<{ r: Claimed[] }>("select public.claim_jobs($1, $2) as r", [kinds, limit])).rows[0].r);
const finish = (job: Claimed | { id: string; lease: string }, ok: boolean, error: string | null = null, final = false, started = true) =>
  asService(
    async (q) => (await q<{ r: string }>("select public.finish_job($1, $2, $3, $4, $5, $6) as r", [job.id, job.lease, ok, error, final, started])).rows[0].r,
  );
const expire = (id: string) => asAdmin((q) => q("update app.jobs set locked_until = now() - interval '1 second' where id = $1", [id]));
// (55) א 1: the send check answers may_send, reason and retry only, whatever the path
const maySend = async (job: Claimed) => {
  const answer = await asService(
    async (q) => (await q<{ r: Record<string, unknown> }>("select public.job_message_may_send($1, $2) as r", [job.id, job.lease])).rows[0].r,
  );
  expect(Object.keys(answer).every((k) => ["may_send", "reason", "retry"].includes(k)), JSON.stringify(answer)).toBe(true);
  return answer;
};
const jobOf = (id: string) => asAdmin(async (q) => (await q<Job>("select * from app.jobs where id = $1", [id])).rows[0]);
// paused_at is server-kept by a trigger; the test moves it back with triggers off for one transaction
const backdatePause = (by: string) =>
  asAdmin(async (q) => {
    await q("set local session_replication_role = replica");
    await q("update public.org_sending_pauses set paused_at = now() - $1::interval where paused", [by]);
  });
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
            await q<{ t: boolean; enqueue: boolean; wake: boolean; seen: boolean }>(
              `select has_table_privilege($1, 'app.jobs', 'select,insert,update,delete') as t,
                      has_function_privilege($1, 'app.enqueue_job(uuid,text,jsonb,timestamptz)', 'execute') as enqueue,
                      has_function_privilege($1, 'app.wake_job_worker()', 'execute') as wake,
                      has_table_privilege($1, 'app.job_kind_seen', 'select,insert,update,delete') as seen`,
              [role],
            )
          ).rows[0],
      );
      expect(rights, role).toEqual({ t: false, enqueue: false, wake: false, seen: false });
      const publics = await asAdmin(
        async (q) =>
          (
            await q<{ c: boolean; f: boolean; m: boolean }>(
              `select has_function_privilege($1, 'public.claim_jobs(text[],integer,integer)', 'execute') as c,
                      has_function_privilege($1, 'public.finish_job(uuid,uuid,boolean,text,boolean,boolean)', 'execute') as f,
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
    for (const bad of ["tomorrow", "2026-11-02", "2026-11-02T10:00", "2026-13-45T10:00:00Z", 1730000000]) {
      expect((await pgError(enqueue(org, { channel: "sms", lead_id: lead, event_at: bad }))).hint, String(bad)).toBe("job:payload");
    }
    await enqueue(org, { channel: "sms", lead_id: lead, event_at: "2026-11-02T10:00:00+02:00" });
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

    // a job at the last try is never claimed past it, even when the dead-on-last-try update did not reach it
    const id3 = await enqueue(org, send(randomUUID()));
    await asAdmin((q) => q("update app.jobs set attempts = 5 where id = $1", [id3]));
    expect(await claim()).toEqual([]);
    expect(await jobOf(id3)).toMatchObject({ status: "queued", attempts: 5 });
    // and it never takes the place of a due job behind it (review L-b)
    const id4 = await enqueue(org, send(randomUUID()));
    const [job4] = await claim(1);
    expect(job4.id).toBe(id4);
    expect(await finish(job4, true)).toBe("done");
  });

  it("(52) ג: a job meeting a pause waits uncounted, is sent after resume, and is cancelled after 24 hours of pause or once its event passed", async () => {
    const lead = await insertLead(owner.id, org, { email: "pause@example.test" });
    await asUser(owner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [org]));
    try {
      const id = await enqueue(org, send(lead));
      const [job] = await claim();
      expect(await maySend(job)).toEqual({ may_send: false, reason: "sending_paused", retry: true });
      const waiting = await jobOf(id);
      expect(waiting).toMatchObject({ status: "queued", attempts: 0, lease_id: null, last_error: "waiting:sending_paused" });
      const wait = await asAdmin(
        async (q) => (await q<{ m: number }>("select round(extract(epoch from next_run_at - now()) / 60)::int as m from app.jobs where id = $1", [id])).rows[0].m,
      );
      expect(wait).toBe(5);
      expect(await finish(job, true)).toBe("stale");
      expect(await claim()).toEqual([]);

      // an event that passed while waiting: cancelled even within the 24 hours
      const past = await enqueue(org, { ...send(lead), event_at: new Date(Date.now() + 60_000).toISOString() });
      await asAdmin((q) => q("update app.jobs set payload = jsonb_set(payload, '{event_at}', to_jsonb($2::text)) where id = $1", [past, new Date(Date.now() - 60_000).toISOString()]));
      const [p] = await claim();
      expect(p.id).toBe(past);
      expect(await maySend(p)).toEqual({ may_send: false, reason: "event_passed" });

      // a future event waits like any other
      const future = await enqueue(org, { ...send(lead), event_at: new Date(Date.now() + 86_400_000).toISOString() });
      const [f] = await claim();
      expect(f.id).toBe(future);
      expect(await maySend(f)).toEqual({ may_send: false, reason: "sending_paused", retry: true });

      // the pause lasts more than 24 hours: cancelled
      await backdatePause("25 hours");
      await due(id);
      const [again] = await claim();
      expect(again.id).toBe(id);
      expect(again.attempt).toBe(1);
      expect(await maySend(again)).toEqual({ may_send: false, reason: "pause_expired" });
      expect(await jobOf(id)).toMatchObject({ status: "refused", last_error: "refused:pause_expired" });

      // within 24 hours and resumed: sent
      await backdatePause("23 hours");
      await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
      await due(future);
      const [resumed] = await claim();
      expect(resumed.id).toBe(future);
      expect(await maySend(resumed)).toEqual({ may_send: true });
      expect(await finish(resumed, true)).toBe("done");
    } finally {
      await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    }
  });

  it("(52) ג: after a resume, a job that waited through a pause of more than 24 hours is cancelled, never sent; a later job is sent", async () => {
    const lead = await insertLead(owner.id, org, { email: "longpause@example.test" });
    const flushed = () => asAdmin(async (q) => (await q<{ n: number }>("select app.flush_job_cancellations() as n")).rows[0].n);
    await flushed();
    await asUser(owner.id, (q) =>
      q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'חירום') on conflict (organization_id) do update set paused = true, reason = 'חירום'", [org]),
    );
    let during = "";
    let later = "";
    let before = "";
    try {
      // made during the pause and never checked (worker down): no "waiting" mark
      during = await enqueue(org, send(lead));
      // made during the pause with a run_at after it
      later = await enqueue(org, send(lead), new Date(Date.now() + 1_000).toISOString());
      await backdatePause("30 hours");
      // made before the pause and due by its end
      before = await enqueue(org, send(lead));
      await asAdmin((q) => q("update app.jobs set created_at = now() - interval '31 hours', next_run_at = now() - interval '31 hours' where id = $1", [before]));
    } finally {
      await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    }
    await due(later);
    const jobs = await claim(10);
    expect(jobs.map((j) => j.id).sort()).toEqual([during, later, before].sort());
    for (const job of jobs) expect(await maySend(job)).toEqual({ may_send: false, reason: "pause_expired" });
    for (const id of [during, later, before]) expect(await jobOf(id)).toMatchObject({ status: "refused", last_error: "refused:pause_expired" });
    expect(await flushed()).toBe(1);

    // made during that long pause for a time after the resume: it never waited, so it is sent (review M-1)
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = true, reason = 'חירום' where organization_id = $1", [org]));
    const scheduled = await enqueue(org, send(lead), new Date(Date.now() + 3_600_000).toISOString());
    await backdatePause("30 hours");
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    // its time comes after the resume
    await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [scheduled]));
    const [sch] = await claim();
    expect(sch.id).toBe(scheduled);
    expect(await maySend(sch)).toEqual({ may_send: true });
    expect(await finish(sch, true)).toBe("done");

    // a job made after the resume is sent normally
    const after = await enqueue(org, send(lead));
    const [a] = await claim();
    expect(a.id).toBe(after);
    expect(await maySend(a)).toEqual({ may_send: true });
    expect(await finish(a, true)).toBe("done");

    // a short pause (under 24 hours) that ended: its waiting jobs are sent
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = true, reason = 'קצר' where organization_id = $1", [org]));
    const short = await enqueue(org, send(lead));
    const [w] = await claim();
    expect(await maySend(w)).toEqual({ may_send: false, reason: "sending_paused", retry: true });
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    await due(short);
    const [sent] = await claim();
    expect(await maySend(sent)).toEqual({ may_send: true });
  });

  it("a pause moves all of the business's due message jobs back in one step, without counting attempts", async () => {
    const lead = await insertLead(owner.id, org, { email: "bulk@example.test" });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await enqueue(org, send(lead)));
    const other = await enqueue(orgB, send(randomUUID()));
    await asUser(owner.id, (q) =>
      q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'חירום') on conflict (organization_id) do update set paused = true, reason = 'חירום'", [org]),
    );
    try {
      const [first] = await claim(1);
      expect(ids).toContain(first.id);
      expect(await maySend(first)).toMatchObject({ reason: "sending_paused", retry: true });
      for (const id of ids) {
        expect(await jobOf(id), id).toMatchObject({ status: "queued", attempts: 0, last_error: "waiting:sending_paused" });
        expect((await jobOf(id)).next_run_at.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
      }
      // another business is untouched; nothing of the paused one is claimable now
      expect(await jobOf(other)).toMatchObject({ status: "queued", last_error: null });
      expect((await claim(10)).map((j) => j.id)).toEqual([other]);
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

  it("an expired lease is stale for the send check and for finish, before and after a reclaim, and changes nothing", async () => {
    const lead = await insertLead(owner.id, org, { email: "lease@example.test" });
    const id = await enqueue(org, send(lead));
    const [old] = await claim();
    await expire(id);
    // not reclaimed yet: the old holder still gets nothing
    expect(await maySend(old)).toEqual({ may_send: false, reason: "stale" });
    expect(await finish(old, true)).toBe("stale");
    expect(await finish(old, false, "x", false, false)).toBe("stale");
    expect(await jobOf(id)).toMatchObject({ status: "running", attempts: 1, last_error: null });
    // reclaimed: the new holder may send, the old one never
    const [fresh] = await claim();
    expect(fresh.id).toBe(id);
    expect(await maySend(old)).toEqual({ may_send: false, reason: "stale" });
    expect(await maySend(fresh)).toEqual({ may_send: true });
    expect(await finish(old, true)).toBe("stale");
    expect(await finish(fresh, true)).toBe("done");
  });

  it("a job claimed but not started is handed back at once, its attempt not counted, and never goes dead untried", async () => {
    const id = await enqueue(org, send(randomUUID()));
    await asAdmin((q) => q("update app.jobs set attempts = 4 where id = $1", [id]));
    for (let i = 0; i < 3; i++) {
      const [job] = await claim();
      expect(job.attempt).toBe(5);
      expect(await finish(job, false, null, false, false)).toBe("released");
      expect(await jobOf(id)).toMatchObject({ status: "queued", attempts: 4, lease_id: null, locked_until: null });
      expect(await finish(job, true)).toBe("stale");
    }
    const [last] = await claim();
    expect(last.id).toBe(id);
    expect(await finish(last, true)).toBe("done");
  });

  it("(53) א, (54) ב: the send check cancels for a soft-deleted or read-only business", async () => {
    const owner2 = await createUser("jobs-deleted");
    const gone = await createOrg(owner2.id, "עסק שנמחק");
    const lead = await insertLead(owner2.id, gone, { email: "deleted@example.test" });
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [gone]));
    const id = await enqueue(gone, send(lead));
    const [job] = await claim();
    expect(job.id).toBe(id);
    expect(await maySend(job)).toEqual({ may_send: false, reason: "business_closed" });
    expect(await jobOf(id)).toMatchObject({ status: "refused", last_error: "refused:business_closed" });
    // (54) ב: a read-only business sends nothing either, like the meeting reminders (app.org_writable)
    const readOnly = await insertLead(owner.id, orgB, { email: "readonly@example.test" });
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [orgB]));
    try {
      await enqueue(orgB, send(readOnly));
      const [r] = await claim();
      expect(await maySend(r)).toEqual({ may_send: false, reason: "business_closed" });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [orgB]));
    }
  });

  it("wakes every minute only for kinds a worker asked for in the last day, else at most once an hour", async () => {
    const kinds = () => asAdmin(async (q) => (await q<{ k: string[] }>("select app.job_wake_kinds() as k")).rows[0].k);
    const seen = (claimed: string | null, woken: string | null) =>
      asAdmin((q) =>
        q("update app.job_kind_seen set last_claimed_at = now() - $1::interval, last_woken_at = now() - $2::interval where kind = 'message.send'", [
          claimed,
          woken,
        ]),
      );
    expect(await kinds()).toEqual([]);
    await enqueue(org, send(randomUUID()));
    await seen(null, null);
    expect(await kinds()).toEqual(["message.send"]); // never asked for, never woken: wake once
    await seen(null, "1 minute");
    expect(await kinds()).toEqual([]); // no worker asks for it: not again within the hour
    await seen("2 days", "59 minutes");
    expect(await kinds()).toEqual([]);
    await seen("2 days", "61 minutes");
    expect(await kinds()).toEqual(["message.send"]);
    await seen("23 hours", "1 minute");
    expect(await kinds()).toEqual(["message.send"]); // asked for in the last day: every minute
    // claim_jobs stamps the kinds it was asked for, even when it claims nothing new
    await asAdmin((q) => q("update app.job_kind_seen set last_claimed_at = null, last_woken_at = now()"));
    await claim(20);
    const stamped = await asAdmin(
      async (q) => (await q<{ ok: boolean }>("select last_claimed_at > now() - interval '1 minute' as ok from app.job_kind_seen where kind = 'message.send'")).rows[0].ok,
    );
    expect(stamped).toBe(true);
    // without pg_net the wake writes nothing
    await asAdmin((q) => q("update app.job_kind_seen set last_woken_at = null"));
    await enqueue(org, send(randomUUID()));
    expect(await asAdmin(async (q) => (await q<{ w: boolean }>("select app.wake_job_worker() as w")).rows[0].w)).toBe(false);
    expect(await asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from app.job_kind_seen where last_woken_at is not null")).rows[0].n)).toBe(0);
  });

  it("cancellations are counted per business in app.platform_log, one entry per business and run, no job ids", async () => {
    const flush = () => asAdmin(async (q) => (await q<{ n: number }>("select app.flush_job_cancellations() as n")).rows[0].n);
    await flush();
    const before = await asAdmin(async (q) => (await q<{ n: number }>("select max(id)::int as n from app.platform_log")).rows[0].n ?? 0);
    for (let i = 0; i < 3; i++) await enqueue(org, send(randomUUID()));
    await enqueue(orgB, send(randomUUID()));
    for (const job of await claim(10)) await maySend(job);
    expect(await flush()).toBe(2);
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ organization_id: string; action: string; actor_id: string | null; details: Record<string, unknown> }>(
            "select organization_id, action, actor_id, details from app.platform_log where id > $1 order by organization_id",
            [before],
          )
        ).rows,
    );
    const byOrg = Object.fromEntries(rows.map((r) => [r.organization_id, r]));
    expect(rows).toHaveLength(2);
    expect(byOrg[org]).toMatchObject({ action: "jobs.cancelled", actor_id: null, details: { counts: { record_gone: 3 }, total: 3 } });
    expect(byOrg[orgB]).toMatchObject({ action: "jobs.cancelled", details: { counts: { record_gone: 1 }, total: 1 } });
    expect(JSON.stringify(rows)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}.*lead|example/);
    expect(Object.keys(byOrg[org].details).sort()).toEqual(["counts", "total"]);
    expect(await flush()).toBe(0);
    // a waiting job (pause) is not a cancellation
    await asUser(owner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'חירום') on conflict (organization_id) do update set paused = true, reason = 'חירום'", [org]));
    try {
      await enqueue(org, send(randomUUID()));
      for (const job of await claim()) await maySend(job);
      expect(await flush()).toBe(0);
    } finally {
      await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    }
  });

  it("(55) א: claim answers exactly id, lease, kind, organization_id, payload, attempt; finish only its status; only the send check reads records", async () => {
    await enqueue(org, { ...send(randomUUID()), event_at: "2030-01-01T09:00:00Z" });
    const [job] = await claim();
    expect(Object.keys(job).sort()).toEqual(["attempt", "id", "kind", "lease", "organization_id", "payload"]);
    expect(Object.keys(job.payload).sort()).toEqual(["channel", "event_at", "lead_id"]);
    const types = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; result: string; src: string }>(
            `select p.proname as name, pg_get_function_result(p.oid) as result, p.prosrc as src from pg_proc p
              where p.oid in ('public.claim_jobs(text[],integer,integer)'::regprocedure,
                              'public.finish_job(uuid,uuid,boolean,text,boolean,boolean)'::regprocedure,
                              'public.job_message_may_send(uuid,uuid)'::regprocedure)
              order by 1`,
          )
        ).rows,
    );
    expect(types.map((t) => [t.name, t.result])).toEqual([
      ["claim_jobs", "jsonb"],
      ["finish_job", "text"],
      ["job_message_may_send", "jsonb"],
    ]);
    const answers = new Set<string>();
    answers.add(await finish({ id: randomUUID(), lease: randomUUID() }, true));
    answers.add(await finish(job, false, null, false, false));
    for (const a of answers) expect(["done", "failed", "dead", "released", "stale"]).toContain(a);
    // claim and finish never touch a customer record: no public table in their bodies
    for (const t of types.filter((x) => x.name !== "job_message_may_send")) expect(t.src, t.name).not.toMatch(/public\./);
    expect(types.find((t) => t.name === "job_message_may_send")?.src).toMatch(/public\.leads/);
  });

  // (55) א: the three functions the worker calls were reviewed against the owner's conditions (only the send check reads
  // customer records and answers may_send/reason/retry; claim and finish answer only what sending needs). A change to any
  // of their bodies fails here until it gets a fresh independent review against those conditions; then update the md5.
  it("(55) א: the bodies of claim_jobs, finish_job and job_message_may_send are the reviewed ones", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; md5: string }>(
            `select p.proname as name,
                    md5(p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_function_identity_arguments(p.oid)) as md5
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname in ('claim_jobs', 'finish_job', 'job_message_may_send') order by 1`,
          )
        ).rows,
    );
    expect(Object.fromEntries(rows.map((r) => [r.name, r.md5]))).toEqual(REVIEWED_MD5);
  });

  // (55) א 3: every job kind needs the owner's own approval and its own "In use" line in CLAUDE.md (hard rule 5).
  // Adding a kind here without that approval is not allowed.
  it("(55) א: the job kinds are exactly {message.send}", async () => {
    const kinds = await asAdmin(async (q) => (await q<{ k: string[] }>("select app.job_kinds() as k")).rows[0].k);
    expect(kinds).toEqual(["message.send"]);
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

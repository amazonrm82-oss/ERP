import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asService, asUser, closePool, createOrg, createUser, type Query } from "./helpers";

afterAll(closePool);

// WEB-05 (owner (418) ב, 18 November 2026): only the service emails to a new sign-up, through ONE OPS-04 job kind
// (signup.send): a welcome when the person's first business is made, and "the trial is about to end" 3 days before its last
// day, from 09:00 in the business's zone. Once per business and kind; never to a business that left its trial, closed or was
// deleted, never to a person who is no longer its active owner. The queue holds ids and a kind only.
//
// Isolation: the cron is run with a far-future "now" (p_now) and only this file's businesses are moved to that time, so the
// businesses other test files make are never in its window.

const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];
// Monday 5 January 2099, 10:00 in Israel (UTC+2): a working day, after 09:00
const NOW = "2099-01-05T08:00:00Z";
const EARLY = "2099-01-05T05:00:00Z"; // 07:00 in Israel

const workerSeen = (seen: boolean) =>
  asAdmin((q) => q("update app.job_kind_seen set last_claimed_at = case when $1 then now() else null end where kind = 'signup.send'", [seen]));
const queue = (now: string, caps: Record<string, number> = {}) =>
  asAdmin(async (q) => {
    // a test may only lower a cap, for this transaction
    for (const [k, v] of Object.entries(caps)) await q("select set_config($1, $2, true)", [`app.signup_email_${k}`, String(v)]);
    return (await one<{ n: number }>(q, "select app.queue_signup_emails(null, $1) as n", [now])).n;
  });
// Owner (444) א: the trial-end switch (BIL-08). Saved before and put back exactly after, so the teardown finds it as built.
type SwitchRow = { enabled: boolean; enabled_at: Date | null; updated_by: string | null; updated_at: Date };
let savedSwitch: SwitchRow | undefined;
const setSwitch = (on: boolean) =>
  asAdmin(async (q) => {
    if (!savedSwitch) savedSwitch = await one<SwitchRow>(q, "select enabled, enabled_at, updated_by, updated_at from app.trial_end_settings where id");
    await q("update app.trial_end_settings set enabled = $1, enabled_at = case when $1 then now() end where id", [on]);
  });
const restoreSwitch = async () => {
  if (!savedSwitch) return;
  const r = savedSwitch;
  await asAdmin((q) =>
    q("update app.trial_end_settings set enabled = $1, enabled_at = $2, updated_by = $3, updated_at = $4 where id", [r.enabled, r.enabled_at, r.updated_by, r.updated_at]),
  );
  savedSwitch = undefined;
};
afterAll(restoreSwitch);
const jobsOf = (org: string) =>
  asAdmin(
    async (q) =>
      (await q<{ id: string; payload: Record<string, string>; next_run_at: Date }>("select id, payload, next_run_at from app.jobs where kind = 'signup.send' and organization_id = $1 order by payload ->> 'kind'", [org])).rows,
  );
// a business made "just before" NOW: created a day before, trial ending as given
const placeOrg = (org: string, created: string, trialEnds: string) =>
  asAdmin(async (q) => {
    // touch_row keeps created_at; the test moves it with the row triggers off for this one statement
    await q("set local session_replication_role = replica");
    await q("update public.organizations set created_at = $2 where id = $1", [org, created]);
    await q("set local session_replication_role = origin");
    await q("update public.subscriptions set trial_ends_at = $2 where organization_id = $1", [org, trialEnds]);
  });
const claim = async (jobId: string) => {
  await asAdmin((q) => q("update app.jobs set next_run_at = now() where id = $1", [jobId]));
  const rows = await asService(async (q) => (await one<{ r: Array<{ id: string; lease: string }> }>(q, "select public.claim_jobs(array['signup.send'], 100) as r")).r);
  const job = rows.find((r) => r.id === jobId);
  expect(job, "claimed").toBeDefined();
  return job!;
};
const compose = (jobId: string, lease: string) =>
  asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.signup_job_compose($1, $2) as r", [jobId, lease])).r);
const claimAndCompose = async (jobId: string) => {
  const job = await claim(jobId);
  return compose(job.id, job.lease);
};

describe("the job kind and its payload", () => {
  const o = "11111111-2222-4333-8444-555555555555";
  const u = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const ok = (payload: unknown) =>
    asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('signup.send', $1) as ok", [JSON.stringify(payload)])).ok);

  it("signup.send holds exactly the business, the person and the kind; never an address or a text", async () => {
    const kinds = await asAdmin(async (q) => (await one<{ k: string[] }>(q, "select app.job_kinds() as k")).k);
    expect(kinds).toContain("signup.send");
    expect(await ok({ organization_id: o, user_id: u, kind: "welcome" })).toBe(true);
    expect(await ok({ organization_id: o, user_id: u, kind: "trial_ending" })).toBe(true);
    expect(await ok({ organization_id: o, user_id: u, kind: "tips" })).toBe(false);
    expect(await ok({ organization_id: o, user_id: u })).toBe(false);
    expect(await ok({ organization_id: o, user_id: u, kind: "welcome", email: "a@x.co" })).toBe(false);
    expect(await ok({ organization_id: "x", user_id: u, kind: "welcome" })).toBe(false);
  });

  it("the send log is in schema app with RLS on and no grants; the composer is service_role only", async () => {
    const t = await asAdmin(async (q) =>
      one<{ rls: boolean; grants: number }>(
        q,
        `select c.relrowsecurity as rls,
                (select count(*)::int from information_schema.role_table_grants g
                  where g.table_schema = 'app' and g.table_name = 'signup_email_sends' and g.grantee in ('anon', 'authenticated', 'service_role')) as grants
           from pg_class c where c.oid = 'app.signup_email_sends'::regclass`,
      ),
    );
    expect(t).toEqual({ rls: true, grants: 0 });
    const ex = await asAdmin(async (q) =>
      one<{ a: boolean; s: boolean }>(
        q,
        "select has_function_privilege('authenticated', 'public.signup_job_compose(uuid, uuid)', 'execute') as a, has_function_privilege('service_role', 'public.signup_job_compose(uuid, uuid)', 'execute') as s",
      ),
    );
    expect(ex).toEqual({ a: false, s: true });
  });
});

describe("queuing and composing", () => {
  let owner: { id: string; email: string };
  let first: string;
  let second: string;

  beforeAll(async () => {
    await setSwitch(true);
    owner = await createUser("signup-owner");
    first = await createOrg(owner.id, "סטודיו ראשון");
    second = await createOrg(owner.id, "עסק שני");
    // the first made a day before NOW, its trial's last day 7 January (trial_ending from 4 January, 09:00); the second made
    // an hour later, its trial far from its end
    await placeOrg(first, "2099-01-04T08:00:00Z", "2099-01-07T20:00:00Z");
    await placeOrg(second, "2099-01-04T09:00:00Z", "2099-01-20T20:00:00Z");
  });

  afterAll(async () => {
    await asAdmin((q) =>
      q("update app.jobs set status = 'refused', last_error = 'test', lease_id = null, locked_until = null, finished_at = now() where kind = 'signup.send' and status in ('queued', 'running')"),
    );
    await workerSeen(false);
    await restoreSwitch();
  });

  it("queues nothing while no worker sends the kind", async () => {
    await workerSeen(false);
    expect(await queue(NOW)).toBe(0);
    expect(await jobsOf(first)).toEqual([]);
  });

  it("a welcome only for the person's first business; trial_ending only from 09:00 and once", async () => {
    await workerSeen(true);
    // 07:00 in Israel: the welcome goes, trial_ending waits for 09:00
    await queue(EARLY);
    expect((await jobsOf(first)).map((j) => j.payload)).toEqual([{ organization_id: first, user_id: owner.id, kind: "welcome" }]);
    expect(await jobsOf(second)).toEqual([]);
    await queue(NOW);
    const jobs = await jobsOf(first);
    expect(jobs.map((j) => j.payload)).toEqual([
      { organization_id: first, user_id: owner.id, kind: "trial_ending" },
      { organization_id: first, user_id: owner.id, kind: "welcome" },
    ]);
    // the second business's trial is far from its end, and it is not the first: nothing
    expect(await jobsOf(second)).toEqual([]);
    // once per business and kind
    await queue(NOW);
    expect(await jobsOf(first)).toHaveLength(2);
  });

  it("the composer answers only the address, the name, the kind and the day", async () => {
    const welcome = (await jobsOf(first)).find((j) => j.payload.kind === "welcome")!;
    const answer = await claimAndCompose(welcome.id);
    expect(answer).toEqual({ to: owner.email, first_name: "signup-owner", business_name: "סטודיו ראשון", kind: "welcome", trial_end_day: "2099-01-07" });
    const stamped = await asAdmin(async (q) => one<{ c: boolean }>(q, "select composed_at is not null as c from app.signup_email_sends where job_id = $1", [welcome.id]));
    expect(stamped.c).toBe(true);
    // a wrong lease is stale
    const stale = await asService(async (q) => (await one<{ r: unknown }>(q, "select public.signup_job_compose($1, gen_random_uuid()) as r", [welcome.id])).r);
    expect(stale).toEqual({ refused: "stale" });
  });

  it("a business that left its trial gets nothing more (queued jobs are refused at send time)", async () => {
    const ending = (await jobsOf(first)).find((j) => j.payload.kind === "trial_ending")!;
    await asAdmin(async (q) => {
      await q("update public.organizations set status = 'active' where id = $1", [first]);
      await q("update public.subscriptions set status = 'active' where organization_id = $1", [first]);
    });
    expect(await claimAndCompose(ending.id)).toEqual({ refused: "not_trialing" });
  });
});

describe("the stops", () => {
  beforeAll(() => setSwitch(true));
  afterAll(restoreSwitch);

  it("never to a person who is no longer the active owner, a closed business or a trial already over", async () => {
    const owner = await createUser("signup-stop-owner");
    const org = await createOrg(owner.id, "עסק נעצר");
    await placeOrg(org, "2099-01-04T08:00:00Z", "2099-01-07T20:00:00Z");
    await workerSeen(true);
    await queue(NOW);
    const jobs = await jobsOf(org);
    expect(jobs).toHaveLength(2);
    // the owner leaves (suspended): both are refused
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, owner.id]));
    expect(await claimAndCompose(jobs[0].id)).toEqual({ refused: "not_owner" });
    await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, owner.id]));
    // the business is closed
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    expect(await claimAndCompose(jobs[1].id)).toEqual({ refused: "business_closed" });
  });

  it("owner (440) ב: a business active from the start (a zero-price plan) gets a welcome without a trial line and no trial_ending; a deleted one nothing", async () => {
    const owner = await createUser("signup-active-owner");
    const org = await createOrg(owner.id, "עסק פעיל");
    await placeOrg(org, "2099-01-04T08:00:00Z", "2099-01-07T20:00:00Z");
    await asAdmin(async (q) => {
      await q("update public.organizations set status = 'active' where id = $1", [org]);
      await q("update public.subscriptions set status = 'active' where organization_id = $1", [org]);
    });
    const owner2 = await createUser("signup-deleted-owner");
    const gone = await createOrg(owner2.id, "עסק שנמחק");
    await placeOrg(gone, "2099-01-04T08:00:00Z", "2099-01-07T20:00:00Z");
    await asAdmin((q) => q("update public.organizations set deleted_at = now() where id = $1", [gone]));
    await workerSeen(true);
    await queue(NOW);
    const jobs = await jobsOf(org);
    expect(jobs.map((j) => j.payload)).toEqual([{ organization_id: org, user_id: owner.id, kind: "welcome" }]);
    expect(await claimAndCompose(jobs[0].id)).toEqual({ to: owner.email, first_name: "signup-active-owner", business_name: "עסק פעיל", kind: "welcome", trial_end_day: null });
    expect(await jobsOf(gone)).toEqual([]);
  });

  it("owner (443) ב: the first name is the first word of the profile's name, never a link, an address or an invisible character", async () => {
    const names: Array<[string | null, string | null]> = [
      ["  דנה   כהן ", "דנה"],
      [null, null],
      ["   ", null],
      ["www.spam.example שלום", null],
      ["a@b.co", null],
      ["https://x.co", null],
      [`דנה${String.fromCharCode(0x202e)}`, null],
      [`דנה${String.fromCharCode(0xfeff)}`, null],
      ["א".repeat(41), null],
      ["א".repeat(40), "א".repeat(40)],
    ];
    await workerSeen(true);
    for (const [full, expected] of names) {
      const owner = await createUser("signup-first-name");
      await asAdmin((q) => q("update public.profiles set full_name = $2 where id = $1", [owner.id, full]));
      const org = await createOrg(owner.id, "עסק שם");
      await placeOrg(org, "2099-01-04T08:00:00Z", "2099-01-20T20:00:00Z");
      await queue(NOW);
      const [welcome] = await jobsOf(org);
      expect(await claimAndCompose(welcome.id), String(full)).toMatchObject({ first_name: expected, kind: "welcome" });
    }
  });

  it("trial_ending goes to the current owner, not before 3 days ahead, nor in the last 12 hours", async () => {
    const owner = await createUser("signup-late-owner");
    const late = await createOrg(owner.id, "עסק מאוחר");
    // made long ago (no welcome), trial ending in 10 hours: too late
    await placeOrg(late, "2098-12-01T08:00:00Z", "2099-01-05T18:00:00Z");
    const owner3 = await createUser("signup-early-owner");
    const early = await createOrg(owner3.id, "עסק מוקדם");
    // last day 9 January: from 6 January only
    await placeOrg(early, "2098-12-01T08:00:00Z", "2099-01-09T10:00:00Z");
    await workerSeen(true);
    await queue(NOW);
    expect(await jobsOf(late)).toEqual([]);
    expect(await jobsOf(early)).toEqual([]);
    await queue("2099-01-06T08:00:00Z");
    expect((await jobsOf(early)).map((j) => j.payload)).toEqual([{ organization_id: early, user_id: owner3.id, kind: "trial_ending" }]);
    const answer = await claimAndCompose((await jobsOf(early))[0].id);
    expect(answer).toMatchObject({ kind: "trial_ending", trial_end_day: "2099-01-09", to: owner3.email });
  });

  it("a business name holding a link is sent as the neutral word", async () => {
    const owner = await createUser("signup-name-owner");
    const org = await createOrg(owner.id, "www.spam.example");
    await placeOrg(org, "2099-01-04T08:00:00Z", "2099-01-20T20:00:00Z");
    await workerSeen(true);
    await queue(NOW);
    const [welcome] = await jobsOf(org);
    expect(await claimAndCompose(welcome.id)).toMatchObject({ business_name: "העסק", kind: "welcome" });
  });

  it("no person writes the send log or calls the composer", async () => {
    const owner = await createUser("signup-rls-owner");
    const org = await createOrg(owner.id, "עסק בדיקה");
    const err = await asUser(owner.id, (q) => q("select public.signup_job_compose(gen_random_uuid(), gen_random_uuid())")).catch((e: { code?: string }) => e.code);
    expect(err).toBe("42501");
    const err2 = await asUser(owner.id, (q) => q("select count(*) from app.signup_email_sends where organization_id = $1", [org])).catch((e: { code?: string }) => e.code);
    expect(err2).toBe("42501");
  });
});


describe("owner (444) א: the trial ending is told only while BIL-08 will really end it", () => {
  afterAll(restoreSwitch);

  it("switch off: the welcome has no trial end day, trial_ending is not queued", async () => {
    await setSwitch(false);
    const owner = await createUser("signup-off-owner");
    const org = await createOrg(owner.id, "עסק כבוי");
    await placeOrg(org, "2099-01-04T08:00:00Z", "2099-01-07T20:00:00Z");
    await workerSeen(true);
    await queue(NOW);
    const jobs = await jobsOf(org);
    expect(jobs.map((j) => j.payload.kind)).toEqual(["welcome"]);
    expect(await claimAndCompose(jobs[0].id)).toEqual({ to: owner.email, first_name: "signup-off-owner", business_name: "עסק כבוי", kind: "welcome", trial_end_day: null });
  });

  it("switch on at queue time, off at send time: trial_ending is refused, nothing sent", async () => {
    const owner = await createUser("signup-onoff-owner");
    const org = await createOrg(owner.id, "עסק מתחלף");
    await placeOrg(org, "2098-12-01T08:00:00Z", "2099-01-07T20:00:00Z");
    await setSwitch(true);
    await workerSeen(true);
    await queue(NOW);
    const [ending] = await jobsOf(org);
    expect(ending.payload.kind).toBe("trial_ending");
    await restoreSwitch();
    await setSwitch(false);
    expect(await claimAndCompose(ending.id)).toEqual({ refused: "trial_end_off" });
  });

  it("switch on: both as before; a business staff assigned by hand after its trial end gets neither", async () => {
    await setSwitch(true);
    const owner = await createUser("signup-hand-owner");
    const org = await createOrg(owner.id, "עסק ידני");
    await placeOrg(org, "2099-01-04T08:00:00Z", "2099-01-07T20:00:00Z");
    const owner2 = await createUser("signup-on-owner");
    const on = await createOrg(owner2.id, "עסק דולק");
    await placeOrg(on, "2099-01-04T08:00:00Z", "2099-01-07T20:00:00Z");
    // the hand assignment the rule of app.trial_end_candidates reads (at or after the trial's end)
    await asAdmin((q) =>
      q("insert into app.platform_assignments (organization_id, assigned_at, kind) values ($1, '2099-01-07T20:00:00Z', 'subscription') on conflict (organization_id) do update set assigned_at = excluded.assigned_at", [org]),
    );
    await workerSeen(true);
    await queue(NOW);
    const handJobs = await jobsOf(org);
    expect(handJobs.map((j) => j.payload.kind)).toEqual(["welcome"]);
    expect(await claimAndCompose(handJobs[0].id)).toMatchObject({ kind: "welcome", trial_end_day: null });
    const onJobs = await jobsOf(on);
    expect(onJobs.map((j) => j.payload.kind)).toEqual(["trial_ending", "welcome"]);
    expect(await claimAndCompose(onJobs[1].id)).toMatchObject({ kind: "welcome", trial_end_day: "2099-01-07" });
    expect(await claimAndCompose(onJobs[0].id)).toMatchObject({ kind: "trial_ending", trial_end_day: "2099-01-07" });
  });
});

describe("the trial's last day, rest days, the composer's refusals and the caps", () => {
  beforeAll(() => setSwitch(true));
  afterAll(async () => {
    await asAdmin((q) =>
      q("update app.jobs set status = 'refused', last_error = 'test', lease_id = null, locked_until = null, finished_at = now() where kind = 'signup.send' and status in ('queued', 'running')"),
    );
    await workerSeen(false);
    await restoreSwitch();
  });

  it("a trial ending exactly at local midnight: its last day is the day before", async () => {
    const owner = await createUser("signup-midnight-owner");
    const org = await createOrg(owner.id, "עסק חצות");
    // 10 January 2099 00:00 in Israel (UTC+2): the last day is 9 January, so the email goes from 6 January
    await placeOrg(org, "2098-12-01T08:00:00Z", "2099-01-09T22:00:00Z");
    await workerSeen(true);
    await queue(NOW);
    expect(await jobsOf(org)).toEqual([]);
    await queue("2099-01-06T08:00:00Z");
    const [ending] = await jobsOf(org);
    expect(ending.payload.kind).toBe("trial_ending");
    expect(await claimAndCompose(ending.id)).toMatchObject({ kind: "trial_ending", trial_end_day: "2099-01-09" });
  });

  it("skips a rest day of the business and goes on the next working day", async () => {
    const owner = await createUser("signup-rest-owner");
    const org = await createOrg(owner.id, "עסק שבת");
    // last day 13 January: from 10 January, a Saturday
    await placeOrg(org, "2098-12-01T08:00:00Z", "2099-01-13T20:00:00Z");
    const rest = await asAdmin(async (q) =>
      one<{ sat: boolean; sun: boolean }>(q, "select app.org_rest_day($1, '2099-01-10') as sat, app.org_rest_day($1, '2099-01-11') as sun", [org]),
    );
    expect(rest).toEqual({ sat: true, sun: false });
    await workerSeen(true);
    await queue("2099-01-10T08:00:00Z");
    expect(await jobsOf(org)).toEqual([]);
    await queue("2099-01-11T08:00:00Z");
    expect((await jobsOf(org)).map((j) => j.payload.kind)).toEqual(["trial_ending"]);
  });

  it("stale on an expired lease; invalid when the queued row names another job", async () => {
    const owner = await createUser("signup-lease-owner");
    const org = await createOrg(owner.id, "עסק חכירה");
    await placeOrg(org, "2099-01-04T08:00:00Z", "2099-01-20T20:00:00Z");
    await workerSeen(true);
    await queue(NOW);
    const [welcome] = await jobsOf(org);
    const job = await claim(welcome.id);
    await asAdmin((q) => q("update app.jobs set locked_until = now() - interval '1 second' where id = $1", [job.id]));
    expect(await compose(job.id, job.lease)).toEqual({ refused: "stale" });
    await asAdmin((q) => q("update app.jobs set locked_until = now() + interval '5 minutes' where id = $1", [job.id]));
    await asAdmin((q) => q("update app.signup_email_sends set job_id = gen_random_uuid() where organization_id = $1 and kind = 'welcome'", [org]));
    expect(await compose(job.id, job.lease)).toEqual({ refused: "invalid" });
  });

  it("the caps can only be lowered, never raised", async () => {
    const caps = await asAdmin(async (q) => {
      await q("select set_config('app.signup_email_per_hour', '5000', true), set_config('app.signup_email_per_person_day', '0', true), set_config('app.signup_email_per_run', '2', true)");
      return one<{ per_hour: number; per_person_day: number; per_run: number }>(q, "select * from app.signup_email_limits()");
    });
    expect(caps).toEqual({ per_hour: 1000, per_person_day: 1, per_run: 2 });
    const plain = await asAdmin(async (q) => one(q, "select * from app.signup_email_limits()"));
    expect(plain).toEqual({ per_hour: 1000, per_person_day: 3, per_run: 500 });
  });

  it("500 a run: no more than the run's cap is queued", async () => {
    const orgs: string[] = [];
    for (const n of [1, 2, 3]) {
      const owner = await createUser(`signup-run-owner-${n}`);
      const org = await createOrg(owner.id, `עסק ריצה ${n}`);
      await placeOrg(org, `2099-07-06T0${n}:00:00Z`, "2099-07-30T20:00:00Z");
      orgs.push(org);
    }
    await workerSeen(true);
    expect(await queue("2099-07-06T08:00:00Z", { per_run: 2 })).toBe(2);
    expect((await Promise.all(orgs.map(jobsOf))).map((j) => j.length)).toEqual([1, 1, 0]);
    expect(await queue("2099-07-06T08:00:00Z", { per_run: 2 })).toBe(1);
    expect((await jobsOf(orgs[2])).map((j) => j.payload.kind)).toEqual(["welcome"]);
  });

  it("1,000 an hour: the hour's cap holds across runs, and frees after an hour", async () => {
    const orgs: string[] = [];
    for (const n of [1, 2]) {
      const owner = await createUser(`signup-hour-owner-${n}`);
      const org = await createOrg(owner.id, `עסק שעה ${n}`);
      await placeOrg(org, `2099-08-03T0${n}:00:00Z`, "2099-08-30T20:00:00Z");
      orgs.push(org);
    }
    await workerSeen(true);
    expect(await queue("2099-08-03T08:00:00Z", { per_hour: 1 })).toBe(1);
    expect(await queue("2099-08-03T08:30:00Z", { per_hour: 1 })).toBe(0);
    expect(await queue("2099-08-03T09:30:00Z", { per_hour: 1 })).toBe(1);
    expect((await Promise.all(orgs.map(jobsOf))).map((j) => j.length)).toEqual([1, 1]);
  });

  it("3 a day per person: one owner of several businesses gets at most that many trial_ending emails in 24 hours", async () => {
    const owner = await createUser("signup-many-owner");
    const a = await createOrg(owner.id, "עסק א");
    const b = await createOrg(owner.id, "עסק ב");
    // made long ago (no welcome); both trials' last day is 12 November 2099 (a Thursday), so from Monday 9 November
    await placeOrg(a, "2099-09-01T08:00:00Z", "2099-11-12T20:00:00Z");
    await placeOrg(b, "2099-09-01T09:00:00Z", "2099-11-12T20:00:00Z");
    await workerSeen(true);
    expect(await queue("2099-11-09T08:00:00Z", { per_person_day: 1 })).toBe(1);
    expect(await queue("2099-11-09T12:00:00Z", { per_person_day: 1 })).toBe(0);
    // a day later the second goes
    expect(await queue("2099-11-10T09:00:00Z", { per_person_day: 1 })).toBe(1);
    expect([...(await jobsOf(a)), ...(await jobsOf(b))].map((j) => j.payload.kind)).toEqual(["trial_ending", "trial_ending"]);
  });
});

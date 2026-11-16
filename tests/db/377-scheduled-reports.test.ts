import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

// RPT-03 (owner (386) א, 16 November 2026): a report sent by email on a schedule, with the report's name, the period and a
// link only. Owners and admins make the schedules; recipients are active members (owners, admins and managers only for a
// restricted report); the job kind report.send holds ids only; the cron queues one job per schedule, recipient and day;
// the composer answers no number of any report and re-checks everything on the job's live lease.

const one = async <T extends object>(q: Query, sql: string, params: unknown[] = []) => (await q<T>(sql, params)).rows[0];

const workerSeen = (seen: boolean) =>
  asAdmin((q) =>
    q("update app.job_kind_seen set last_claimed_at = case when $1 then now() else null end where kind = 'report.send'", [seen]),
  );

type U = { id: string; email: string };

const create = (user: string, org: string, args: { report: string; period?: string | null; frequency?: string; weekday?: number | null; at?: string; recipients: string[] }) =>
  asUser(user, async (q) =>
    (
      await one<{ id: string }>(q, "select public.scheduled_report_create($1, $2, $3, $4, $5, $6, $7) as id", [
        org,
        args.report,
        args.period === undefined ? "last_7" : args.period,
        args.frequency ?? "weekly",
        args.weekday === undefined ? 1 : args.weekday,
        args.at ?? "08:00",
        args.recipients,
      ])
    ).id,
  );

describe("the job kind and its payload", () => {
  const s = "11111111-2222-4333-8444-555555555555";
  const u = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const ok = (payload: unknown) =>
    asAdmin(async (q) => (await one<{ ok: boolean }>(q, "select app.job_payload_ok('report.send', $1) as ok", [JSON.stringify(payload)])).ok);

  it("report.send is a known kind and holds exactly the schedule, the recipient and the day", async () => {
    const kinds = await asAdmin(async (q) => (await one<{ k: string[] }>(q, "select app.job_kinds() as k")).k);
    expect(kinds).toContain("report.send");
    expect(await ok({ schedule_id: s, user_id: u, day: "2026-11-16" })).toBe(true);
    expect(await ok({ schedule_id: s, user_id: u })).toBe(false);
    expect(await ok({ schedule_id: s, user_id: u, day: "2026-11-16", report_key: "revenue" })).toBe(false);
    expect(await ok({ schedule_id: s, user_id: u, day: "2026-11-16", to: "a@example.test" })).toBe(false);
    expect(await ok({ schedule_id: "x", user_id: u, day: "2026-11-16" })).toBe(false);
    expect(await ok({ schedule_id: s, user_id: u, day: "16/11/2026" })).toBe(false);
    expect(await ok({ schedule_id: s, user_id: u, day: 20261116 })).toBe(false);
    // the other kinds keep their own rules
    const other = await asAdmin(async (q) =>
      (await one<{ ok: boolean }>(q, "select app.job_payload_ok('digest.send', $1) as ok", [JSON.stringify({ schedule_id: s, user_id: u, day: "2026-11-16" })])).ok,
    );
    expect(other).toBe(false);
  });

  it("the periods are worked out on the business's day", async () => {
    const period = (p: string, today: string) =>
      asAdmin(async (q) =>
        one<{ f: string; t: string }>(q, "select to_char(from_date, 'YYYY-MM-DD') as f, to_char(to_date, 'YYYY-MM-DD') as t from app.scheduled_report_period($1, $2::date)", [p, today]),
      );
    expect(await period("yesterday", "2026-11-16")).toEqual({ f: "2026-11-15", t: "2026-11-15" });
    expect(await period("last_7", "2026-11-16")).toEqual({ f: "2026-11-09", t: "2026-11-15" });
    expect(await period("this_month", "2026-11-16")).toEqual({ f: "2026-11-01", t: "2026-11-16" });
    expect(await period("last_month", "2026-03-05")).toEqual({ f: "2026-02-01", t: "2026-02-28" });
    expect(await period("last_month", "2026-01-10")).toEqual({ f: "2025-12-01", t: "2025-12-31" });
    expect(await period("last_30", "2026-11-16")).toEqual({ f: "2026-10-17", t: "2026-11-15" });
  });
});

describe("who makes a schedule and who receives it", () => {
  let owner: U, admin: U, manager: U, member: U, viewer: U, outsider: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("rs-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "rs-admin");
    manager = await addMember(org, owner.id, "manager", "rs-manager");
    member = await addMember(org, owner.id, "member", "rs-member");
    viewer = await addMember(org, owner.id, "member", "rs-other");
    outsider = await createUser("rs-outsider");
  });

  it("owners and admins make one with its recipients in one call; managers, members and outsiders cannot", async () => {
    const id = await create(owner.id, org, { report: "revenue", recipients: [manager.id, member.id] });
    expect(await asAdmin((q) => count(q, "select 1 from public.report_schedule_recipients where schedule_id = $1", [id]))).toBe(2);
    expect(await create(admin.id, org, { report: "funnel", frequency: "daily", weekday: null, recipients: [admin.id] })).toMatch(/^[0-9a-f-]{36}$/);
    for (const u of [manager, member, outsider]) {
      expect((await pgError(create(u.id, org, { report: "revenue", recipients: [u.id] }))).code, u.email).toBe("42501");
    }
    // created_by is the session's
    const by = await asAdmin(async (q) => (await one<{ c: string }>(q, "select created_by as c from public.report_schedules where id = $1", [id])).c);
    expect(by).toBe(owner.id);
  });

  it("refuses an unknown report, a missing period, a bad time and a report the plan does not hold", async () => {
    expect((await pgError(create(owner.id, org, { report: "nope", recipients: [owner.id] }))).hint).toBe("report_schedule:report");
    expect((await pgError(create(owner.id, org, { report: "revenue", period: null, recipients: [owner.id] }))).hint).toBe("report_schedule:period");
    expect((await pgError(create(owner.id, org, { report: "revenue", period: "last_year", recipients: [owner.id] }))).code).toBe("23514");
    expect((await pgError(create(owner.id, org, { report: "revenue", at: "05:45", recipients: [owner.id] }))).code).toBe("23514");
    expect((await pgError(create(owner.id, org, { report: "revenue", at: "08:10", recipients: [owner.id] }))).code).toBe("23514");
    expect((await pgError(create(owner.id, org, { report: "revenue", recipients: [] }))).hint).toBe("report_schedule:recipients");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = $2 where organization_id = $1", [org, JSON.stringify({ quotes: false })]));
    expect((await pgError(create(owner.id, org, { report: "quotes", recipients: [owner.id] }))).hint).toBe("report_schedule:unavailable");
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}'::jsonb where organization_id = $1", [org]));
    // a report without a period keeps none
    const stuck = await create(owner.id, org, { report: "stuck", period: "last_7", recipients: [owner.id] });
    expect(await asAdmin(async (q) => (await one<{ p: string | null }>(q, "select period as p from public.report_schedules where id = $1", [stuck])).p)).toBeNull();
  });

  it("a restricted report goes to owners, admins and managers only; a recipient is an active member of this business", async () => {
    expect((await pgError(create(owner.id, org, { report: "profit", recipients: [member.id] }))).hint).toBe("report_schedule:recipient_role");
    expect(await create(owner.id, org, { report: "profit", recipients: [manager.id, admin.id] })).toMatch(/^[0-9a-f-]{36}$/);
    expect((await pgError(create(owner.id, org, { report: "revenue", recipients: [outsider.id] }))).hint).toBe("report_schedule:recipient");
  });

  it("a member sees only the schedules they receive and may take themselves off; nobody changes the report or the recipient", async () => {
    const id = await create(owner.id, org, { report: "activity", recipients: [member.id, manager.id] });
    const seen = await asUser(member.id, (q) => count(q, "select 1 from public.report_schedules where id = $1", [id]));
    expect(seen).toBe(1);
    expect(await asUser(viewer.id, (q) => count(q, "select 1 from public.report_schedules where id = $1", [id]))).toBe(0);
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.report_schedule_recipients where schedule_id = $1", [id]))).toBe(1);
    // a member cannot take someone else off
    expect(await asUser(member.id, async (q) => (await q("delete from public.report_schedule_recipients where schedule_id = $1 and user_id = $2", [id, manager.id])).rowCount)).toBe(0);
    expect(await asUser(member.id, async (q) => (await q("delete from public.report_schedule_recipients where schedule_id = $1 and user_id = $2", [id, member.id])).rowCount)).toBe(1);
    expect((await pgError(asUser(owner.id, (q) => q("update public.report_schedules set report_key = 'funnel' where id = $1", [id])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("update public.report_schedule_recipients set user_id = $2 where schedule_id = $1", [id, owner.id])))).code).toBe("42501");
    // a member cannot switch it
    expect(await asUser(member.id, async (q) => (await q("update public.report_schedules set enabled = false where id = $1", [id])).rowCount)).toBe(0);
    expect(await asUser(owner.id, async (q) => (await q("update public.report_schedules set enabled = false where id = $1", [id])).rowCount)).toBe(1);
  });

  it("an outsider sees nothing", async () => {
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.report_schedules where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.report_schedule_recipients where organization_id = $1", [org]))).toBe(0);
  });

  it("at most 20 recipients, and 20 schedules a business", async () => {
    const id = await create(owner.id, org, { report: "lost", recipients: [owner.id] });
    const many = Array.from({ length: 21 }, () => owner.id);
    expect((await pgError(create(owner.id, org, { report: "lost", recipients: many }))).hint).toBe("report_schedule:recipients_max");
    const existing = await asAdmin((q) => count(q, "select 1 from public.report_schedules where organization_id = $1", [org]));
    for (let i = existing; i < 20; i += 1) await create(owner.id, org, { report: "cycle", recipients: [owner.id] });
    expect((await pgError(create(owner.id, org, { report: "cycle", recipients: [owner.id] }))).hint).toBe("report_schedules:max");
    expect(id).toBeTruthy();
  });
});

describe("the cron and the composer", () => {
  let owner: U, manager: U, member: U, gone: U;
  let org: string;
  let weekly: string;
  let restricted: string;

  // Monday 16 November 2026 08:30 in Jerusalem (UTC+2)
  const MONDAY_0830 = "2026-11-16T06:30:00Z";
  const MONDAY_0745 = "2026-11-16T05:45:00Z";
  const queue = (at: string) =>
    asAdmin(async (q) => (await one<{ n: number }>(q, "select app.queue_scheduled_reports(2000, $1::timestamptz) as n", [at])).n);
  const jobsOf = () =>
    asAdmin(async (q) =>
      (await q<{ payload: Record<string, string> }>("select payload from app.jobs where organization_id = $1 and kind = 'report.send' order by payload ->> 'user_id', payload ->> 'schedule_id'", [org])).rows,
    );
  const claimed = async (user: string, schedule: string, day: string) => {
    await asAdmin((q) =>
      q("select app.enqueue_job($1, 'report.send', $2, now() - interval '1 second')", [org, JSON.stringify({ schedule_id: schedule, user_id: user, day })]),
    );
    const rows = await asService(async (q) => (await one<{ r: Array<{ id: string; lease: string; payload: Record<string, string> }> }>(q, "select public.claim_jobs(array['report.send'], 100) as r")).r);
    const mine = rows.find((r) => r.payload.user_id === user && r.payload.schedule_id === schedule && r.payload.day === day);
    expect(mine).toBeDefined();
    return { id: mine!.id, lease: mine!.lease };
  };
  const compose = (job: { id: string; lease: string }) =>
    asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.scheduled_report_compose($1, $2) as r", [job.id, job.lease])).r);
  const today = () =>
    asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from public.organizations where id = $1", [org])).d);

  beforeAll(async () => {
    owner = await createUser("rsc-owner");
    org = await createOrg(owner.id, "עסק הדוחות");
    manager = await addMember(org, owner.id, "manager", "rsc-manager");
    member = await addMember(org, owner.id, "member", "rsc-member");
    gone = await addMember(org, owner.id, "member", "rsc-gone");
    weekly = await create(owner.id, org, { report: "revenue", period: "last_7", frequency: "weekly", weekday: 1, recipients: [member.id, gone.id] });
    restricted = await create(owner.id, org, { report: "profit", period: "last_month", frequency: "weekly", weekday: 1, recipients: [manager.id] });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, gone.id]));
  });

  afterAll(async () => {
    await asAdmin((q) =>
      q(
        "update app.jobs set status = 'refused', last_error = 'test', lease_id = null, locked_until = null, finished_at = now() where kind = 'report.send' and status in ('queued', 'running')",
      ),
    );
    await workerSeen(false);
  });

  it("queues nothing while no worker asked for the kind", async () => {
    await workerSeen(false);
    expect(await queue(MONDAY_0830)).toBe(0);
  });

  it("queues one job per schedule and active recipient on the weekday from the send time, once", async () => {
    await workerSeen(true);
    expect(await queue(MONDAY_0745)).toBe(0);
    expect(await queue(MONDAY_0830)).toBeGreaterThanOrEqual(2);
    const jobs = await jobsOf();
    const pairs = jobs.map((j) => `${j.payload.schedule_id}:${j.payload.user_id}`).sort();
    expect(pairs).toEqual([`${restricted}:${manager.id}`, `${weekly}:${member.id}`].sort());
    for (const j of jobs) {
      expect(Object.keys(j.payload).sort()).toEqual(["day", "schedule_id", "user_id"]);
      expect(j.payload.day).toBe("2026-11-16");
    }
    // the same day again: nothing new; the next day (Tuesday) a weekly schedule waits for Monday
    await queue("2026-11-16T07:30:00Z");
    // (another business's daily schedule may be queued on Tuesday; this business's weekly ones are not)
    await queue("2026-11-17T06:30:00Z");
    expect((await jobsOf()).length).toBe(2);
  });

  it("the composer answers the address, the business, the report and the period only, never a number", async () => {
    const day = await today();
    const job = await claimed(member.id, weekly, day);
    const r = await compose(job);
    expect(Object.keys(r).sort()).toEqual(["business_name", "day", "from_date", "period", "report_key", "terms", "to", "to_date"]);
    expect(r.terms).toEqual({});
    await asUser(owner.id, (q) => q("insert into public.org_terms (organization_id, lead_term) values ($1, 'inquiry')", [org]));
    const again = await compose(await claimed(member.id, weekly, day));
    expect(again.terms).toEqual({ contact_term: null, lead_term: "inquiry", deal_term: null });
    expect(r.to).toBe(member.email);
    expect(r.business_name).toBe("עסק הדוחות");
    expect(r.report_key).toBe("revenue");
    expect(r.period).toBe("last_7");
    expect(String(r.from_date)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.day).toBe(day);
  });

  it("refuses on a stale lease and when anything changed since the job was queued", async () => {
    const day = await today();
    const job = await claimed(member.id, weekly, day);
    expect(await compose({ id: job.id, lease: "00000000-0000-4000-8000-000000000000" })).toEqual({ refused: "stale" });
    await asUser(owner.id, (q) => q("update public.report_schedules set enabled = false where id = $1", [weekly]));
    expect(await compose(job)).toEqual({ refused: "switched_off" });
    await asUser(owner.id, (q) => q("update public.report_schedules set enabled = true where id = $1", [weekly]));
    expect(await compose(await claimed(member.id, weekly, "2020-01-01"))).toEqual({ refused: "expired" });
    expect(await compose(await claimed(gone.id, weekly, day))).toEqual({ refused: "not_member" });
    expect(await compose(await claimed(owner.id, weekly, day))).toEqual({ refused: "not_recipient" });
    // the manager became a member: a restricted report is no longer theirs
    const job2 = await claimed(manager.id, restricted, day);
    await asAdmin((q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, manager.id]));
    try {
      expect(await compose(job2)).toEqual({ refused: "not_allowed" });
    } finally {
      await asAdmin((q) => q("update public.memberships set role = 'manager' where organization_id = $1 and user_id = $2", [org, manager.id]));
    }
    const status = await asAdmin(async (q) => (await one<{ s: string }>(q, "select status::text as s from public.organizations where id = $1", [org])).s);
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    try {
      expect(await compose(job)).toEqual({ refused: "business_closed" });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $2::public.org_status where id = $1", [org, status]));
    }
  });

  it("only the service role calls the composer", async () => {
    const err = await pgError(asUser(owner.id, (q) => q("select public.scheduled_report_compose('00000000-0000-4000-8000-000000000000', '00000000-0000-4000-8000-000000000000')")));
    expect(err.code).toBe("42501");
  });
});

// review fixes 2, 4, 6, 7: the evening send times, the day cap run past its end (and kept through a schedule's removal), a
// member on leave, a daily schedule on a rest day, the leads module off, a plan key lost at send time, and the cost reports
describe("the cron's rules, run for real", () => {
  let owner: U;
  let org: string;
  const members: U[] = [];
  const queue = (at: string) =>
    asAdmin(async (q) => (await one<{ n: number }>(q, "select app.queue_scheduled_reports(2000, $1::timestamptz) as n", [at])).n);
  const jobsFor = (schedule: string) =>
    asAdmin((q) => count(q, "select 1 from app.jobs where organization_id = $1 and kind = 'report.send' and payload ->> 'schedule_id' = $2", [org, schedule]));
  const orgJobs = () => asAdmin((q) => count(q, "select 1 from app.jobs where organization_id = $1 and kind = 'report.send'", [org]));

  beforeAll(async () => {
    owner = await createUser("rsx-owner");
    org = await createOrg(owner.id, "עסק הכללים");
    await asAdmin((q) => q(`update public.subscriptions set limit_overrides = '{"max_users": 60}' where organization_id = $1`, [org]));
    for (let i = 0; i < 19; i += 1) members.push(await addMember(org, owner.id, "member", `rsx-m${i}`));
    await workerSeen(true);
  });

  afterAll(async () => {
    await asAdmin((q) =>
      q("update app.jobs set status = 'refused', last_error = 'test', lease_id = null, locked_until = null, finished_at = now() where kind = 'report.send' and status in ('queued', 'running')"),
    );
    await workerSeen(false);
  });

  it("a send time between 21:00 and 22:00 is sent (no wrap past midnight)", async () => {
    // Monday 7 December 2026; Jerusalem is UTC+2
    const late = await create(owner.id, org, { report: "funnel", frequency: "weekly", weekday: 1, at: "21:30", recipients: [owner.id] });
    const last = await create(owner.id, org, { report: "lost", frequency: "weekly", weekday: 1, at: "22:00", recipients: [owner.id] });
    await queue("2026-12-07T19:15:00Z"); // 21:15: before both
    expect(await jobsFor(late)).toBe(0);
    await queue("2026-12-07T19:45:00Z"); // 21:45
    expect(await jobsFor(late)).toBe(1);
    expect(await jobsFor(last)).toBe(0);
    await queue("2026-12-07T21:50:00Z"); // 23:50
    expect(await jobsFor(last)).toBe(1);
    for (const id of [late, last]) await asUser(owner.id, (q) => q("delete from public.report_schedules where id = $1", [id]));
  });

  it("a member on leave gets nothing; a daily schedule skips a rest day", async () => {
    const away = members[0];
    await asUser(owner.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-12-08', '2026-12-08')", [org, away.id]));
    const daily = await create(owner.id, org, { report: "activity", frequency: "daily", weekday: null, at: "08:00", recipients: [away.id, members[1].id] });
    await queue("2026-12-08T06:30:00Z"); // Tuesday 08:30, away is on leave
    const who = async () =>
      asAdmin(async (q) =>
        (await q<{ u: string }>("select payload ->> 'user_id' as u from app.jobs where organization_id = $1 and payload ->> 'schedule_id' = $2 order by 1", [org, daily])).rows.map((r) => r.u),
      );
    expect(await who()).toEqual([members[1].id]);
    // Saturday is a rest day by default: nothing; Sunday: both
    await queue("2026-12-12T06:30:00Z");
    expect((await who()).length).toBe(1);
    await queue("2026-12-13T06:30:00Z");
    expect((await who()).length).toBe(3);
    await asUser(owner.id, (q) => q("delete from public.report_schedules where id = $1", [daily]));
  });

  it("the leads module off, or a plan key lost, stops the report at queue and at send time", async () => {
    const sources = await create(owner.id, org, { report: "sources", frequency: "weekly", weekday: 3, at: "08:00", recipients: [owner.id] });
    const quotes = await create(owner.id, org, { report: "quotes", frequency: "weekly", weekday: 3, at: "08:00", recipients: [owner.id] });
    await asAdmin((q) => q("insert into public.org_modules (organization_id, leads_enabled) values ($1, false) on conflict (organization_id) do update set leads_enabled = false", [org]));
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{\"quotes\": false}' where organization_id = $1", [org]));
    try {
      await queue("2026-12-09T06:30:00Z"); // Wednesday
      expect(await jobsFor(sources)).toBe(0);
      expect(await jobsFor(quotes)).toBe(0);
      // a job queued earlier is refused when the module or the key went away
      const day = await asAdmin(async (q) => (await one<{ d: string }>(q, "select to_char((now() at time zone timezone)::date, 'YYYY-MM-DD') as d from public.organizations where id = $1", [org])).d);
      for (const schedule of [sources, quotes]) {
        await asAdmin((q) => q("select app.enqueue_job($1, 'report.send', $2, now() - interval '1 second')", [org, JSON.stringify({ schedule_id: schedule, user_id: owner.id, day })]));
        const rows = await asService(async (q) => (await one<{ r: Array<{ id: string; lease: string; payload: Record<string, string> }> }>(q, "select public.claim_jobs(array['report.send'], 100) as r")).r);
        const job = rows.find((r) => r.payload.schedule_id === schedule)!;
        const r = await asService(async (q) => (await one<{ r: Record<string, unknown> }>(q, "select public.scheduled_report_compose($1, $2) as r", [job.id, job.lease])).r);
        expect(r).toEqual({ refused: "unavailable" });
      }
    } finally {
      await asAdmin((q) => q("update public.org_modules set leads_enabled = true where organization_id = $1", [org]));
      await asAdmin((q) => q("update public.subscriptions set feature_overrides = '{}'::jsonb where organization_id = $1", [org]));
    }
    for (const id of [sources, quotes]) await asUser(owner.id, (q) => q("delete from public.report_schedules where id = $1", [id]));
  });

  it("the cost reports go to owners, admins and managers only", async () => {
    for (const report of ["categories", "campaign_roi", "profit"]) {
      const user_may = await asAdmin(async (q) => (await one<{ m: boolean }>(q, "select app.scheduled_report_user_may($1, $2, $3) as m", [org, members[2].id, report])).m);
      expect(user_may, report).toBe(false);
      expect(await asAdmin(async (q) => (await one<{ m: boolean }>(q, "select app.scheduled_report_user_may($1, $2, $3) as m", [org, owner.id, report])).m)).toBe(true);
    }
    expect((await pgError(create(owner.id, org, { report: "categories", recipients: [members[2].id] }))).hint).toBe("report_schedule:recipient_role");
  });

  it("caps a business at 200 report emails a day, and removing a schedule gives nothing back", async () => {
    const cap = await asAdmin(async (q) => (await one<{ c: number }>(q, "select app.report_schedule_day_cap() as c")).c);
    expect(cap).toBe(200);
    const everyone = [owner.id, ...members.map((m) => m.id)];
    expect(everyone.length).toBe(20);
    await asAdmin((q) => q("delete from app.jobs where organization_id = $1 and kind = 'report.send'", [org]));
    const schedules: string[] = [];
    for (let i = 0; i < 11; i += 1) schedules.push(await create(owner.id, org, { report: "revenue", frequency: "weekly", weekday: 4, at: "08:00", recipients: everyone }));
    await queue("2026-12-10T06:30:00Z"); // Thursday: 220 wanted
    expect(await orgJobs()).toBe(200);
    await queue("2026-12-10T07:30:00Z");
    expect(await orgJobs()).toBe(200);
    // removing schedules and making a new one the same day: the day's sends stay counted
    for (const id of schedules.slice(0, 3)) await asUser(owner.id, (q) => q("delete from public.report_schedules where id = $1", [id]));
    expect(await asAdmin((q) => count(q, "select 1 from app.report_schedule_sends where organization_id = $1 and day = '2026-12-10'", [org]))).toBe(200);
    const fresh = await create(owner.id, org, { report: "funnel", frequency: "weekly", weekday: 4, at: "08:00", recipients: everyone });
    await queue("2026-12-10T08:00:00Z");
    expect(await jobsFor(fresh)).toBe(0);
    expect(await orgJobs()).toBe(200);
    // the next week starts again: the 8 schedules left and the new one, 9 x 20
    await queue("2026-12-17T06:30:00Z");
    expect(await orgJobs()).toBe(380);
  });
});

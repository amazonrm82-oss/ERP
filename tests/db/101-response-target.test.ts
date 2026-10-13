import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError, TEST_DB_URL } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Hours = Record<string, { start: string; end: string }[]>;

const EVERY_DAY = (start: string, end: string): Hours =>
  Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start, end }]]));

// CAP-10: the business's response target, the working-time deadline, and the
// manager's notice when an intake lead was not answered in time.
describe("response target for a new lead (CAP-10)", () => {
  let owner: U, admin: U, manager: U, rep1: U, rep2: U, outsider: U;
  let org: string;
  let team: string;
  let token: string;

  // rest_weekdays null = the CAL-03 default (Friday and Saturday)
  const setCalendar = (restWeekdays: number[] | null, hours: Hours | null, holidays = false) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, working_hours) values ($1, $2, $3, $4)
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays, holidays_rest = excluded.holidays_rest,
           working_hours = excluded.working_hours`,
        [org, restWeekdays ?? [5, 6], holidays, hours === null ? null : JSON.stringify(hours)],
      ),
    );
  const deadline = (from: string, minutes: number) =>
    asAdmin(async (q) => (await q<{ t: Date | null }>("select app.response_deadline($1, $2, $3) as t", [org, from, minutes])).rows[0].t?.toISOString() ?? null);
  const submit = (phone: string) =>
    asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [token, JSON.stringify({ full_name: "פונה חדש", phone })])).rows[0].r.lead_id);
  // the lead's clock started this many minutes ago
  const age = (lead: string, minutes: number) =>
    asAdmin((q) => q("update app.lead_response_checks set window_start = now() - make_interval(mins => $2), next_check_at = now() where lead_id = $1", [lead, minutes]));
  // one run of the job, other organizations' rows set aside
  const run = (orgId = org) =>
    asAdmin(async (q) => {
      await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> $1", [orgId]);
      return (await q<{ n: number }>("select app.check_lead_responses() as n")).rows[0].n;
    });
  const check = (lead: string) =>
    asAdmin(async (q) => (await q<{ outcome: string | null; resolved: boolean; owner_id: string | null }>("select outcome, resolved_at is not null as resolved, owner_id from app.lead_response_checks where lead_id = $1", [lead])).rows[0]);
  const overdueNotices = (lead: string) =>
    asAdmin(async (q) => (await q<{ user_id: string; title: string; body: string | null }>("select user_id, title, body from public.notifications where entity_id = $1 and type = 'response_overdue' order by user_id", [lead])).rows);

  beforeAll(async () => {
    owner = await createUser("rt-owner");
    org = await createOrg(owner.id, "עסק היעד");
    admin = await addMember(org, owner.id, "admin", "rt-admin");
    manager = await addMember(org, owner.id, "manager", "rt-manager");
    rep1 = await addMember(org, owner.id, "member", "rt-rep1");
    rep2 = await addMember(org, owner.id, "member", "rt-rep2");
    outsider = await createUser("rt-outsider");
    await createOrg(outsider.id, "עסק אחר");
    await asAdmin((q) => q("update public.organizations set record_visibility = 'team' where id = $1", [org]));
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, true), ($1, $2, $4, false), ($1, $2, $5, false)", [
        org,
        team,
        manager.id,
        rep1.id,
        rep2.id,
      ]);
      token = (
        await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, team_id) values ($1, 'webhook', 'אתר', $2, $3) returning token", [org, rep1.id, team])
      ).rows[0].token;
    });
    // every day is a working day, no hours: wall-clock time
    await setCalendar([], null);
  });

  it("the setting: 5 to 1440 minutes, a known action, at most one row", async () => {
    for (const minutes of [4, 1441]) {
      expect((await pgError(asUser(owner.id, (q) => q("insert into public.lead_response_settings (organization_id, target_minutes) values ($1, $2)", [org, minutes])))).code).toBe("23514");
    }
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.lead_response_settings (organization_id, breach_action) values ($1, 'bogus')", [org])))).code).toBe("23514");
    await asUser(owner.id, (q) => q("insert into public.lead_response_settings (organization_id, target_minutes) values ($1, 5)", [org]));
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.lead_response_settings (organization_id, target_minutes) values ($1, 10)", [org])))).code).toBe("23505");
    // the reports read the same number
    const target = await asUser(rep1.id, async (q) =>
      (await q<{ r: { target_minutes: number } }>("select public.report_response_breakdown($1, now() - interval '1 day', now()) as r", [org])).rows[0].r.target_minutes,
    );
    expect(target).toBe(5);
    // audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'lead_response_settings'", [org]))).toBeGreaterThanOrEqual(1);
    await asUser(owner.id, (q) => q("update public.lead_response_settings set target_minutes = 60 where organization_id = $1", [org]));
  });

  it("the deadline counts working time: wall-clock with no hours and no rest days", async () => {
    await setCalendar([], null);
    expect(await deadline("2026-10-18T07:00:00Z", 60)).toBe("2026-10-18T08:00:00.000Z");
    expect(await deadline("2026-10-18T07:00:00Z", 1440)).toBe("2026-10-19T07:00:00.000Z");
  });

  it("the deadline skips the business's rest days, also with no hours set (a Saturday lead waits for Sunday)", async () => {
    await setCalendar(null, null);
    // Friday 16 October 2026 13:00 in Israel (UTC+3): Friday and Saturday are rest days, Sunday 00:00 + 60 minutes
    expect(await deadline("2026-10-16T10:00:00Z", 60)).toBe("2026-10-17T22:00:00.000Z");
    // Thursday 23:30: 30 minutes on Thursday, 30 on Sunday
    expect(await deadline("2026-10-15T20:30:00Z", 60)).toBe("2026-10-17T21:30:00.000Z");
  });

  it("the deadline counts only the business's hours, in its zone", async () => {
    await setCalendar([], EVERY_DAY("08:00", "18:00"));
    // Sunday 17:30: 30 minutes on Sunday, 30 from Monday 08:00
    expect(await deadline("2026-10-18T14:30:00Z", 60)).toBe("2026-10-19T05:30:00.000Z");
    // before opening: from 08:00
    expect(await deadline("2026-10-18T02:00:00Z", 15)).toBe("2026-10-18T05:15:00.000Z");
    // split hours: 30 minutes before the break, 30 after it
    await setCalendar([], { sun: [{ start: "09:00", end: "13:00" }, { start: "16:00", end: "20:00" }] });
    expect(await deadline("2026-10-18T09:30:00Z", 60)).toBe("2026-10-18T13:30:00.000Z");
    // a range ending 23:59 runs to midnight; the next one is a week later, after the clocks go back (25 October)
    await setCalendar([], { sun: [{ start: "22:00", end: "23:59" }] });
    expect(await deadline("2026-10-18T20:30:00Z", 60)).toBe("2026-10-25T20:30:00.000Z");
    // hours and rest days together: Saturday morning is closed, Sunday from 08:00
    await setCalendar(null, EVERY_DAY("08:00", "18:00"));
    expect(await deadline("2026-10-17T07:00:00Z", 60)).toBe("2026-10-18T06:00:00.000Z");
    await setCalendar([], null);
  });

  it("only leads that came in through intake are watched", async () => {
    const intake = await submit("054-7100001");
    expect(await check(intake)).toMatchObject({ resolved: false, owner_id: rep1.id });
    const manual = await insertLead(rep1.id, org, { full_name: "ליד ידני", owner_id: rep1.id });
    expect(await asAdmin((q) => count(q, "select 1 from app.lead_response_checks where lead_id = $1", [manual]))).toBe(0);
  });

  it("not answered in time: the team's manager is told once, the owner is not", async () => {
    const lead = await submit("054-7100002");
    // within the target: nothing
    await age(lead, 30);
    expect(await run()).toBe(0);
    expect(await overdueNotices(lead)).toEqual([]);
    await age(lead, 61);
    expect(await run()).toBe(1);
    const notes = await overdueNotices(lead);
    expect(notes.map((n) => n.user_id)).toEqual([manager.id]);
    expect(notes[0].title).toBe("ליד מחכה למענה יותר מ-60 דקות");
    expect(notes[0].body).toContain("פונה חדש");
    expect(await check(lead)).toMatchObject({ resolved: true, outcome: "notified" });
    // once per lead
    await asAdmin((q) => q("update app.lead_response_checks set next_check_at = now() where lead_id = $1", [lead]));
    expect(await run()).toBe(0);
    expect((await overdueNotices(lead)).length).toBe(1);
  });

  it("an answer by a person stops the clock; a private note or a system entry does not", async () => {
    const lead = await submit("054-7100003");
    await asUser(rep1.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id, is_private) values ($1, 'note', 'לבדוק', $2, true)", [org, lead]));
    await asAdmin((q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'note', 'מערכת', $2)", [org, lead]));
    await age(lead, 61);
    expect(await run()).toBe(1);

    const answered = await submit("054-7100004");
    await asUser(rep1.id, (q) => q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'דיברנו', $2)", [org, answered]));
    await age(answered, 61);
    expect(await run()).toBe(0);
    expect(await overdueNotices(answered)).toEqual([]);
    expect(await check(answered)).toMatchObject({ resolved: true, outcome: "contacted" });
  });

  it("a closed, converted or deleted lead is left alone", async () => {
    const lead = await submit("054-7100005");
    await asUser(owner.id, (q) => q("update public.leads set deleted_at = now() where id = $1", [lead]));
    await age(lead, 61);
    expect(await run()).toBe(0);
    expect(await check(lead)).toMatchObject({ resolved: true, outcome: "closed" });
  });

  it("a new owner gets a clock of their own; a lead with no owner waits", async () => {
    const lead = await submit("054-7100006");
    await age(lead, 50);
    await asUser(owner.id, (q) => q("update public.leads set owner_id = $2 where id = $1", [lead, rep2.id]));
    // the clock restarted for rep2, so 15 minutes later it is not late
    await asAdmin((q) => q("update app.lead_response_checks set window_start = window_start - interval '15 minutes', next_check_at = now() where lead_id = $1", [lead]));
    expect(await run()).toBe(0);
    expect(await check(lead)).toMatchObject({ resolved: false, owner_id: rep2.id });
    // no owner: nobody is told, the row waits for one
    await asUser(owner.id, (q) => q("update public.leads set owner_id = null where id = $1", [lead]));
    await age(lead, 600);
    expect(await run()).toBe(0);
    expect(await overdueNotices(lead)).toEqual([]);
    expect(await check(lead)).toMatchObject({ resolved: false, owner_id: null });
  });

  it("no team manager: the owners and admins are told", async () => {
    const lead = await submit("054-7100007");
    await asUser(owner.id, (q) => q("update public.leads set team_id = null where id = $1", [lead]));
    await age(lead, 61);
    expect(await run()).toBe(1);
    expect(new Set((await overdueNotices(lead)).map((n) => n.user_id))).toEqual(new Set([owner.id, admin.id]));
  });

  it("the target and the action are the business's: a longer target waits, 'none' does nothing", async () => {
    await asUser(owner.id, (q) => q("update public.lead_response_settings set target_minutes = 120 where organization_id = $1", [org]));
    const lead = await submit("054-7100008");
    await age(lead, 61);
    expect(await run()).toBe(0);
    await asUser(owner.id, (q) => q("update public.lead_response_settings set breach_action = 'none' where organization_id = $1", [org]));
    await age(lead, 121);
    expect(await run()).toBe(0);
    expect(await overdueNotices(lead)).toEqual([]);
    expect(await check(lead)).toMatchObject({ resolved: true, outcome: "no_action" });
    await asUser(owner.id, (q) => q("update public.lead_response_settings set target_minutes = 60, breach_action = 'notify' where organization_id = $1", [org]));
  });

  it("a read-only organization is left alone until it is writable again", async () => {
    const lead = await submit("054-7100009");
    await age(lead, 61);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await run()).toBe(0);
      expect(await check(lead)).toMatchObject({ resolved: false });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    await age(lead, 61);
    expect(await run()).toBe(1);
  });

  it("a lead and its row held by another session: the run neither waits nor fails (review L3)", async () => {
    const lead = await submit("054-7100030");
    await age(lead, 61);
    const holder = new Client({ connectionString: TEST_DB_URL });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from public.leads where id = $1 for update", [lead]);
      await holder.query("select 1 from app.lead_response_checks where lead_id = $1 for update", [lead]);
      const n = await asAdmin(async (q) => {
        await q("set local lock_timeout = '3s'");
        await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> $1", [org]);
        return (await q<{ n: number }>("select app.check_lead_responses() as n")).rows[0].n;
      });
      expect(n).toBe(0);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    // the row was left as it was, and is handled on the next run
    expect(await check(lead)).toMatchObject({ resolved: false });
    expect(await run()).toBe(1);
  });

  it("the job is fair between organizations and bounded per run", async () => {
    const otherOwner = await createUser("rt-fair-owner");
    const other = await createOrg(otherOwner.id, "עסק הוגן");
    const otherToken = await asUser(otherOwner.id, async (q) => {
      await q("insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest) values ($1, '{}', false)", [other]);
      return (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id) values ($1, 'webhook', 'אתר', $2) returning token", [other, otherOwner.id])).rows[0].token;
    });
    const mine: string[] = [];
    for (let i = 0; i < 4; i++) mine.push(await submit(`054-71001${10 + i}`));
    const theirs = await asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [otherToken, JSON.stringify({ full_name: "פונה", phone: "054-7100199" })])).rows[0].r.lead_id);
    for (const lead of [...mine, theirs]) await age(lead, 61);
    const n = await asAdmin(async (q) => {
      await q("update app.lead_response_checks set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> all ($1::uuid[])", [[org, other]]);
      await q("select set_config('app.response_check_per_org', '2', true), set_config('app.response_check_limit', '3', true)");
      return (await q<{ n: number }>("select app.check_lead_responses() as n")).rows[0].n;
    });
    expect(n).toBe(3);
    expect(await check(theirs)).toMatchObject({ resolved: true, outcome: "notified" });
    // the other organization has no manager or admin but its owner, who owns the lead: told anyway
    expect((await overdueNotices(theirs)).map((r) => r.user_id)).toEqual([otherOwner.id]);
    expect(await asAdmin((q) => count(q, "select 1 from app.lead_response_checks where lead_id = any ($1) and resolved_at is null", [mine]))).toBe(2);
  });

  it("the job, the deadline and the watch list are not reachable from the API", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select 1 from app.lead_response_checks")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.check_lead_responses()")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.response_deadline($1, now(), 5)", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select * from app.response_managers($1, null, null)", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.response_check_later($1, interval '1 minute')", [org])))).code).toBe("42501");
    // a stranger reads no setting, and gets the initial 60
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.lead_response_settings where organization_id = $1", [org]))).toBe(0);
  });
});

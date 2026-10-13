import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

// BIL-08 partial (owner, 13 October 2026): the trial-end transition, built OFF behind one platform switch.
const START = "תקופת הניסיון הסתיימה";
const WEEK = "עוד שבוע העסק עובר לקריאה בלבד";
const DAY = "מחר העסק עובר לקריאה בלבד";
const READ_ONLY = "העסק עבר לקריאה בלבד";
const CLOSE_PREFIX = "מחר, ";
const TITLES = [START, WEEK, DAY, READ_ONLY];

// platform staff made here leave at the end: another file checks it holds the only platform owner
const staffIds: string[] = [];
const makeStaff = (userId: string, role: string) => {
  staffIds.push(userId);
  return asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));
};

/** A business with its own owner (and an admin and a member), whose trial ended a day ago. */
async function endedTrialOrg(label: string) {
  const owner = await createUser(`${label}-owner`);
  const org = await createOrg(owner.id, `עסק ${label}`);
  const admin = await addMember(org, owner.id, "admin", `${label}-admin`);
  const member = await addMember(org, owner.id, "member", `${label}-member`);
  await asAdmin((q) => q("update public.subscriptions set trial_ends_at = now() - interval '1 day' where organization_id = $1", [org]));
  return { org, owner, admin, member };
}
type Biz = Awaited<ReturnType<typeof endedTrialOrg>>;

/** Runs the daily job for one business at (switch-on moment, or now while off) + an interval. */
const run = (org: string, after: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ r: Record<string, unknown> }>(
          "select app.run_trial_end(coalesce((select st.enabled_at from app.trial_end_settings st where st.id and st.enabled), now()) + $1::interval, $2) as r",
          [after, org],
        )
      ).rows[0].r,
  );
/** Runs the daily job for one business at an exact moment. */
const runAt = (org: string, at: string) => asAdmin((q) => q("select app.run_trial_end($1::timestamptz, $2)", [at, org]));

const state = (org: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ status: string; plan_key: string; sub_status: string }>(
          "select o.status, s.plan_key, s.status as sub_status from public.organizations o join public.subscriptions s on s.organization_id = o.id where o.id = $1",
          [org],
        )
      ).rows[0],
  );

/** Trial-end notices a user got: title -> count (the closing reminder is counted as "close"). */
const notices = (org: string, userId: string) =>
  asAdmin(async (q) => {
    const rows = (
      await q<{ title: string; n: number }>(
        `select case when title like $3 || '%הגישה לעסק נסגרת' then 'close' else title end as title, count(*)::int as n
           from public.notifications
          where organization_id = $1 and user_id = $2 and type = 'system'
            and (title = any($4) or title like $3 || '%הגישה לעסק נסגרת')
          group by 1`,
        [org, userId, CLOSE_PREFIX, TITLES],
      )
    ).rows;
    return Object.fromEntries(rows.map((r) => [r.title, r.n]));
  });

const bodyOf = (org: string, userId: string, like: string) =>
  asAdmin(
    async (q) =>
      (await q<{ t: string }>("select title || ' | ' || body as t from public.notifications where organization_id = $1 and user_id = $2 and title like $3", [org, userId, like]))
        .rows[0]?.t ?? null,
  );

const notice = (org: string, userId: string) =>
  asUser(userId, async (q) => (await q<{ n: { phase: string; read_only_on: string; closes_on: string } | null }>("select public.trial_end_notice($1) as n", [org])).rows[0].n);

const setSwitch = (userId: string, on: boolean) =>
  asMfaUser(userId, async (q) => (await q<{ r: { changed: boolean; restored?: number } }>("select public.platform_set_trial_end($1) as r", [on])).rows[0].r);

const switchStatus = (userId: string) =>
  asMfaUser(userId, async (q) => (await q<{ r: Record<string, unknown> }>("select public.platform_trial_end_status() as r")).rows[0].r);

/** Days between two local calendar days of an organization's zone. */
const localDays = (org: string, fromSql: string, toSql: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ d: number }>(
          `select ((${toSql}) at time zone o.timezone)::date - ((${fromSql}) at time zone o.timezone)::date as d
             from app.trial_end_transitions tr
             join public.organizations o on o.id = tr.organization_id
             join public.subscriptions s on s.organization_id = tr.organization_id
             cross join app.trial_end_settings st
            where tr.organization_id = $1 and tr.ended_at is null`,
          [org],
        )
      ).rows[0].d,
  );

const setStatus = (staff: string, org: string, status: string) =>
  asMfaUser(staff, (q) => q("select public.platform_set_org_status($1, $2::public.org_status, 'ידני')", [org, status]));

/** Walks one business from the start of the grace to read-only (anchor offsets, see below). */
async function toReadOnly(org: string) {
  for (const at of ["0 seconds", "8 days", "14 days", "15 days"]) await run(org, at);
}

afterAll(async () => {
  // leave the switch off and no open transition behind, as switching off would
  await asAdmin((q) => q("update app.trial_end_transitions set ended_at = now(), ended_reason = 'switch_off' where ended_at is null"));
  await asAdmin((q) => q("update app.trial_end_settings set enabled = false, enabled_at = null"));
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

describe("trial end switch", () => {
  let pOwner: { id: string };
  let a: Biz;
  let manual: Biz;
  let noEnd: Biz;

  beforeAll(async () => {
    pOwner = await createUser("te-platform-owner");
    await makeStaff(pOwner.id, "owner");
    await asAdmin((q) => q("update app.trial_end_settings set enabled = false, enabled_at = null"));
    a = await endedTrialOrg("te-a");
    // assigned by hand: the platform set the business active
    manual = await endedTrialOrg("te-manual");
    await setStatus(pOwner.id, manual.org, "active");
    // assigned by hand: the trial end was cleared
    noEnd = await endedTrialOrg("te-noend");
    await asMfaUser(pOwner.id, (q) => q("select public.platform_update_subscription($1, 'pro', null, null, 'שויך ידנית')", [noEnd.org]));
  });

  it("is off by default, and off changes nothing for an ended trial: no notice, still writable, still pro", async () => {
    expect((await switchStatus(pOwner.id)).enabled).toBe(false);
    expect(await run(a.org, "30 days")).toEqual({ enabled: false });
    expect(await state(a.org)).toEqual({ status: "trial", plan_key: "pro", sub_status: "trialing" });
    expect(await notices(a.org, a.owner.id)).toEqual({});
    expect(await notice(a.org, a.owner.id)).toBeNull();
  });

  it("only the platform owner flips it; other staff and customers cannot; every staff role reads it", async () => {
    for (const role of ["support", "finance", "readonly"]) {
      const staff = await createUser(`te-${role}`);
      await makeStaff(staff.id, role);
      expect((await pgError(setSwitch(staff.id, true))).code, role).toBe("42501");
      expect((await switchStatus(staff.id)).enabled, role).toBe(false);
    }
    expect((await pgError(setSwitch(a.owner.id, true))).code).toBe("42501");
    expect((await pgError(asMfaUser(a.owner.id, (q) => q("select public.platform_trial_end_status()")))).code).toBe("42501");
    // the platform owner without a second factor
    expect((await pgError(asUser(pOwner.id, (q) => q("select public.platform_set_trial_end(true)")))).code).toBe("42501");
    // app functions and tables are not reachable from the API
    expect((await pgError(asUser(a.owner.id, (q) => q("select app.run_trial_end()")))).code).toBe("42501");
    expect((await pgError(asUser(a.owner.id, (q) => q("select * from app.trial_end_settings")))).code).toBe("42501");
    expect((await pgError(asUser(a.owner.id, (q) => q("select * from app.platform_assignments")))).code).toBe("42501");
  });

  it("the status shows how many businesses the next run would start; hand-assigned ones are not counted", async () => {
    const before = (await switchStatus(pOwner.id)) as { waiting: number };
    const expected = await asAdmin((q) => count(q, "select 1 from app.trial_end_candidates(now())"));
    expect(before.waiting).toBe(expected);
    const ids = await asAdmin(async (q) => (await q<{ id: string }>("select id from app.trial_end_candidates(now()) c(id)")).rows.map((r) => r.id));
    expect(ids).toContain(a.org);
    expect(ids).not.toContain(manual.org);
    expect(ids).not.toContain(noEnd.org);
    // noEnd (trial cleared) counts as assigned by hand; manual got a status but its trial end stayed past
    expect((await switchStatus(pOwner.id)).assigned).toBeGreaterThanOrEqual(2);
  });

  it("switching on is logged; the next run starts the grace with the first notice to owners and admins only", async () => {
    expect((await setSwitch(pOwner.id, true)).changed).toBe(true);
    expect((await setSwitch(pOwner.id, true)).changed).toBe(false);
    const log = await asAdmin(
      async (q) =>
        (await q<{ actor_id: string; details: { old: boolean; new: boolean } }>("select actor_id, details from app.platform_log where action = 'trial_end.switch' order by id desc limit 1")).rows[0],
    );
    expect(log.actor_id).toBe(pOwner.id);
    expect(log.details).toMatchObject({ old: false, new: true });
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'trial_end.switch' and actor_id = $1", [pOwner.id]))).toBe(1);
    // switching on only records the moment: the daily job starts the transition
    expect(await notice(a.org, a.owner.id)).toBeNull();

    // from here on the switch-on moment is noon today in Israel, so day boundaries are far away
    await asAdmin((q) => q("update app.trial_end_settings set enabled_at = ((now() at time zone 'Asia/Jerusalem')::date + time '12:00') at time zone 'Asia/Jerusalem'"));
    await run(a.org, "0 seconds");

    // read-only from the start of the local day after day 14; closing 7 local days later
    expect(await localDays(a.org, "st.enabled_at", "tr.grace_starts_at")).toBe(0);
    expect(await localDays(a.org, "st.enabled_at", "tr.read_only_at")).toBe(15);
    expect(await localDays(a.org, "tr.read_only_at", "tr.closes_at")).toBe(7);
    expect(
      await asAdmin(
        async (q) =>
          (await q<{ t: string }>("select to_char(tr.read_only_at at time zone 'Asia/Jerusalem', 'HH24:MI') as t from app.trial_end_transitions tr where tr.organization_id = $1 and tr.ended_at is null", [a.org]))
            .rows[0].t,
      ),
    ).toBe("00:00");

    expect(await notices(a.org, a.owner.id)).toEqual({ [START]: 1 });
    expect(await notices(a.org, a.admin.id)).toEqual({ [START]: 1 });
    expect(await notices(a.org, a.member.id)).toEqual({});
    expect((await notice(a.org, a.member.id))?.phase).toBe("grace");
    expect(await state(a.org)).toEqual({ status: "trial", plan_key: "pro", sub_status: "trialing" });
    // someone outside the business sees nothing
    expect(await notice(a.org, manual.owner.id)).toBeNull();
  });

  it("a business given a plan or a status by hand is not touched", async () => {
    for (const b of [manual, noEnd]) {
      await run(b.org, "0 seconds");
      await run(b.org, "16 days");
      expect(await notice(b.org, b.owner.id)).toBeNull();
      expect(await notices(b.org, b.owner.id)).toEqual({});
    }
    expect(await asAdmin((q) => count(q, "select 1 from app.trial_end_transitions where organization_id = any($1)", [[manual.org, noEnd.org]]))).toBe(0);
  });

  it("HIGH-1: a plan changed by hand with the past trial date kept is not taken through the transition", async () => {
    const kept = await endedTrialOrg("te-kept");
    await asMfaUser(pOwner.id, (q) =>
      q("select public.platform_update_subscription($1, 'pro', 5, (select trial_ends_at from public.subscriptions where organization_id = $1), 'שויך ידנית')", [kept.org]),
    );
    for (const at of ["0 seconds", "8 days", "14 days", "15 days", "16 days"]) await run(kept.org, at);
    expect(await state(kept.org)).toEqual({ status: "trial", plan_key: "pro", sub_status: "trialing" });
    expect(await notices(kept.org, kept.owner.id)).toEqual({});

    // and the same during the grace: the transition ends, no more reminders, never read-only
    const midPlan = await endedTrialOrg("te-mid-plan");
    await run(midPlan.org, "0 seconds");
    expect((await notice(midPlan.org, midPlan.owner.id))?.phase).toBe("grace");
    await asMfaUser(pOwner.id, (q) =>
      q("select public.platform_update_subscription($1, 'pro', 3, (select trial_ends_at from public.subscriptions where organization_id = $1), 'שילם')", [midPlan.org]),
    );
    for (const at of ["8 days", "14 days", "15 days", "16 days"]) await run(midPlan.org, at);
    expect((await state(midPlan.org)).status).toBe("trial");
    expect(await notices(midPlan.org, midPlan.owner.id)).toEqual({ [START]: 1 });
    expect(await notice(midPlan.org, midPlan.owner.id)).toBeNull();
  });

  it("reminders 7 days and 1 day before read-only, once each, and none to a plain member", async () => {
    await run(a.org, "1 hour");
    expect(await notices(a.org, a.owner.id)).toEqual({ [START]: 1 });
    await run(a.org, "8 days");
    await run(a.org, "8 days 2 hours");
    expect(await notices(a.org, a.owner.id)).toEqual({ [START]: 1, [WEEK]: 1 });
    await run(a.org, "14 days");
    await run(a.org, "14 days 2 hours");
    expect(await notices(a.org, a.owner.id)).toEqual({ [START]: 1, [WEEK]: 1, [DAY]: 1 });
    expect(await notices(a.org, a.admin.id)).toEqual({ [START]: 1, [WEEK]: 1, [DAY]: 1 });
    expect(await notices(a.org, a.member.id)).toEqual({});
    expect((await state(a.org)).status).toBe("trial");
  });

  it("read-only from the next local day with a notice, closed (suspended) a week later after a reminder, never on plan free", async () => {
    await run(a.org, "15 days");
    expect(await state(a.org)).toEqual({ status: "read_only", plan_key: "pro", sub_status: "trialing" });
    expect((await notice(a.org, a.member.id))?.phase).toBe("read_only");
    expect(await notices(a.org, a.owner.id)).toEqual({ [START]: 1, [WEEK]: 1, [DAY]: 1, [READ_ONLY]: 1 });
    await run(a.org, "20 days");
    expect((await state(a.org)).status).toBe("read_only");
    await run(a.org, "21 days");
    expect((await state(a.org)).status).toBe("read_only");
    expect((await notices(a.org, a.owner.id)).close).toBe(1);
    expect(await bodyOf(a.org, a.owner.id, `${CLOSE_PREFIX}%`)).toContain("בעוד יום הגישה לעסק תיסגר עד לתשלום. אפשר להוריד את כל הנתונים בהגדרות.");
    await run(a.org, "21 days 6 hours");
    expect((await state(a.org)).status).toBe("read_only");
    await run(a.org, "22 days");
    expect(await state(a.org)).toEqual({ status: "suspended", plan_key: "pro", sub_status: "trialing" });
    expect(await notice(a.org, a.owner.id)).toBeNull();
    // later runs leave it alone, and no notice came twice
    await run(a.org, "40 days");
    expect((await state(a.org)).status).toBe("suspended");
    expect(await notices(a.org, a.owner.id)).toEqual({ [START]: 1, [WEEK]: 1, [DAY]: 1, [READ_ONLY]: 1, close: 1 });
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where organization_id = $1 and action in ('trial_end.read_only', 'trial_end.closed')", [a.org]))).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from public.subscriptions where organization_id = any($1) and plan_key = 'free'", [[a.org, manual.org, noEnd.org]]))).toBe(0);
    for (const b of [manual, noEnd]) {
      await run(b.org, "40 days");
      expect((await state(b.org)).plan_key).toBe("pro");
    }
    expect((await state(manual.org)).status).toBe("active");
    expect((await state(noEnd.org)).status).toBe("trial");
  });

  it("HIGH-2: a business staff restore to trial after closing does not go back into the transition", async () => {
    await setStatus(pOwner.id, a.org, "trial");
    for (const at of ["41 days", "50 days", "60 days"]) await run(a.org, at);
    expect((await state(a.org)).status).toBe("trial");
    expect(await notice(a.org, a.owner.id)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.trial_end_transitions where organization_id = $1", [a.org]))).toBe(1);
  });

  it("HIGH-2: a business staff restore to trial while read-only does not go back into the transition", async () => {
    const back = await endedTrialOrg("te-back");
    await toReadOnly(back.org);
    expect((await state(back.org)).status).toBe("read_only");
    await setStatus(pOwner.id, back.org, "trial");
    for (const at of ["16 days", "17 days", "30 days"]) await run(back.org, at);
    expect((await state(back.org)).status).toBe("trial");
    expect(await notice(back.org, back.owner.id)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.trial_end_transitions where organization_id = $1 and ended_reason = 'manual'", [back.org]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.trial_end_transitions where organization_id = $1", [back.org]))).toBe(1);
  });

  it("no new transition for a trial end this switch-on already handled, even without a hand assignment", async () => {
    const again = await endedTrialOrg("te-again");
    await toReadOnly(again.org);
    // the status changed outside the platform functions (no marker): the transition ends as manual
    await asAdmin((q) => q("update public.organizations set status = 'trial' where id = $1", [again.org]));
    for (const at of ["16 days", "17 days"]) await run(again.org, at);
    expect((await state(again.org)).status).toBe("trial");
    expect(await asAdmin((q) => count(q, "select 1 from app.trial_end_transitions where organization_id = $1", [again.org]))).toBe(1);
  });

  it("a trial that ends after the switch was turned on gets its days from its own end", async () => {
    const late = await endedTrialOrg("te-late");
    await asAdmin((q) =>
      q("update public.subscriptions set trial_ends_at = (select enabled_at from app.trial_end_settings where id) + interval '3 days' where organization_id = $1", [late.org]),
    );
    await run(late.org, "1 day");
    expect(await notice(late.org, late.owner.id)).toBeNull();
    await run(late.org, "4 days");
    expect(await localDays(late.org, "s.trial_ends_at", "tr.read_only_at")).toBe(15);
  });

  it("given a status by hand during the grace: no more reminders, never read-only", async () => {
    const mid = await endedTrialOrg("te-mid");
    await run(mid.org, "0 seconds");
    expect((await notice(mid.org, mid.owner.id))?.phase).toBe("grace");
    await setStatus(pOwner.id, mid.org, "active");
    await run(mid.org, "15 days");
    await run(mid.org, "30 days");
    expect((await state(mid.org)).status).toBe("active");
    expect(await notices(mid.org, mid.owner.id)).toEqual({ [START]: 1 });
    expect(await notice(mid.org, mid.owner.id)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.trial_end_transitions where organization_id = $1 and ended_reason = 'manual'", [mid.org]))).toBe(1);
  });

  it("M-1: read-only by the rule, then a plan assigned by hand: it works again on the next run", async () => {
    const paid = await endedTrialOrg("te-paid");
    await toReadOnly(paid.org);
    expect((await state(paid.org)).status).toBe("read_only");
    await asMfaUser(pOwner.id, (q) =>
      q("select public.platform_update_subscription($1, 'pro', 4, (select trial_ends_at from public.subscriptions where organization_id = $1), 'שילם')", [paid.org]),
    );
    await run(paid.org, "16 days");
    expect(await state(paid.org)).toEqual({ status: "trial", plan_key: "pro", sub_status: "trialing" });
    expect(await notice(paid.org, paid.owner.id)).toBeNull();
    const log = await asAdmin(
      async (q) => (await q<{ details: { reason: string } }>("select details from app.platform_log where organization_id = $1 and action = 'trial_end.restored'", [paid.org])).rows,
    );
    expect(log.map((row) => row.details.reason)).toEqual(["assigned"]);
    // and it stays out: later runs do not take it back
    for (const at of ["17 days", "40 days"]) await run(paid.org, at);
    expect((await state(paid.org)).status).toBe("trial");

    // a status staff chose by hand is kept, even read-only
    const kept = await endedTrialOrg("te-status-kept");
    await toReadOnly(kept.org);
    await setStatus(pOwner.id, kept.org, "read_only");
    await run(kept.org, "16 days");
    expect((await state(kept.org)).status).toBe("read_only");
    expect(await notice(kept.org, kept.owner.id)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where organization_id = $1 and action = 'trial_end.restored'", [kept.org]))).toBe(0);
  });

  it("a trial extended while read-only works again", async () => {
    const ext = await endedTrialOrg("te-ext");
    await toReadOnly(ext.org);
    expect((await state(ext.org)).status).toBe("read_only");
    await asMfaUser(pOwner.id, (q) => q("select public.platform_update_subscription($1, 'pro', null, now() + interval '60 days', 'הארכה')", [ext.org]));
    await run(ext.org, "16 days");
    expect((await state(ext.org)).status).toBe("trial");
    expect(await notice(ext.org, ext.owner.id)).toBeNull();
  });

  it("switching off ends the transitions, opens what the rule made read-only, keeps closed ones closed, and is logged", async () => {
    const ro = await endedTrialOrg("te-off-ro");
    const grace = await endedTrialOrg("te-off-grace");
    const closed = await endedTrialOrg("te-off-closed");
    await toReadOnly(ro.org);
    await toReadOnly(closed.org);
    for (const at of ["21 days", "22 days"]) await run(closed.org, at);
    await run(grace.org, "0 seconds");
    expect((await state(ro.org)).status).toBe("read_only");
    expect((await state(closed.org)).status).toBe("suspended");

    const result = await setSwitch(pOwner.id, false);
    expect(result.changed).toBe(true);
    expect(result.restored).toBeGreaterThanOrEqual(1);
    expect((await state(ro.org)).status).toBe("trial");
    expect((await state(grace.org)).status).toBe("trial");
    expect((await state(closed.org)).status).toBe("suspended");
    expect(await notice(ro.org, ro.owner.id)).toBeNull();
    expect(await notice(grace.org, grace.owner.id)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.trial_end_transitions where ended_at is null"))).toBe(0);
    const log = await asAdmin(
      async (q) => (await q<{ details: { old: boolean; new: boolean } }>("select details from app.platform_log where action = 'trial_end.switch' order by id desc limit 1")).rows[0],
    );
    expect(log.details).toMatchObject({ old: true, new: false });

    // off: the job does nothing at all
    expect(await run(grace.org, "60 days")).toEqual({ enabled: false });
    expect((await state(grace.org)).status).toBe("trial");
    expect(await notices(grace.org, grace.owner.id)).toEqual({ [START]: 1 });
  });

  it("MED-1: switched on at 10:00 Israel time, every date shown is the day the change happens", async () => {
    expect((await setSwitch(pOwner.id, true)).changed).toBe(true);
    await asAdmin((q) => q("update app.trial_end_settings set enabled_at = '2026-10-13 10:00:00 Asia/Jerusalem'"));
    const on = await endedTrialOrg("te-dates");
    const skip = await endedTrialOrg("te-skip");
    await asAdmin((q) => q("update public.subscriptions set trial_ends_at = '2026-10-01 12:00:00 Asia/Jerusalem' where organization_id = any($1)", [[on.org, skip.org]]));

    // the daily job runs at 04:10 UTC (07:10 in Israel)
    await runAt(on.org, "2026-10-14T04:10:00Z");
    expect(await notice(on.org, on.owner.id)).toMatchObject({ phase: "grace", read_only_on: "2026-10-28", closes_on: "2026-11-04" });
    expect(await bodyOf(on.org, on.owner.id, START)).toContain("28.10.2026");
    await runAt(on.org, "2026-10-20T04:10:00Z");
    expect((await notices(on.org, on.owner.id))[WEEK]).toBeUndefined();
    await runAt(on.org, "2026-10-21T04:10:00Z");
    expect(await bodyOf(on.org, on.owner.id, WEEK)).toContain("28.10.2026");
    await runAt(on.org, "2026-10-26T04:10:00Z");
    expect((await notices(on.org, on.owner.id))[DAY]).toBeUndefined();
    await runAt(on.org, "2026-10-27T04:10:00Z");
    expect(await bodyOf(on.org, on.owner.id, DAY)).toContain("מחר, 28.10.2026");
    expect((await state(on.org)).status).toBe("trial");
    await runAt(on.org, "2026-10-28T04:10:00Z");
    expect((await state(on.org)).status).toBe("read_only");
    expect(await notice(on.org, on.owner.id)).toMatchObject({ phase: "read_only", read_only_on: "2026-10-28", closes_on: "2026-11-04" });
    expect(await bodyOf(on.org, on.owner.id, READ_ONLY)).toContain("04.11.2026");
    await runAt(on.org, "2026-11-03T04:10:00Z");
    expect((await state(on.org)).status).toBe("read_only");
    expect(await bodyOf(on.org, on.owner.id, `${CLOSE_PREFIX}%`)).toContain("04.11.2026");
    await runAt(on.org, "2026-11-04T04:10:00Z");
    expect((await state(on.org)).status).toBe("suspended");

    // a run missed on the day before: the late reminder moves read-only to the next day, and says so
    await runAt(skip.org, "2026-10-14T04:10:00Z");
    await runAt(skip.org, "2026-10-28T04:10:00Z");
    expect((await state(skip.org)).status).toBe("trial");
    expect(await notice(skip.org, skip.owner.id)).toMatchObject({ phase: "grace", read_only_on: "2026-10-29" });
    expect(await bodyOf(skip.org, skip.owner.id, DAY)).toContain("מחר, 29.10.2026");
    await runAt(skip.org, "2026-10-29T04:10:00Z");
    expect((await state(skip.org)).status).toBe("read_only");
    expect((await notice(skip.org, skip.owner.id))?.closes_on).toBe("2026-11-05");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, type CalendarSettings } from "@/features/calendar-days/holidays";
import type { WorkingHours } from "@/features/profile/working-hours";
import { memberInHours, type Leave } from "@/features/work-hours/in-hours";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const ALL_DAY: WorkingHours = Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "00:00", end: "23:59" }]]),
) as WorkingHours;
const EIGHT_TO_SIX: WorkingHours = Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "08:00", end: "18:00" }]]),
) as WorkingHours;
const ALWAYS_OPEN: CalendarSettings = { restWeekdays: [], holidaysRest: false, holidayEvesRest: false, restOccasions: [] };

// CAP-09: working hours and leave, app.member_in_hours() and its TS mirror, and
// the round robin that skips whoever is outside hours or on leave.
describe("working hours and leave in lead distribution (CAP-09)", () => {
  let owner: U, admin: U, admin2: U, rep1: U, rep2: U, rep3: U, viewer: U, outsider: U;
  let org: string;
  let otherOrg: string;
  let team: string;

  const setCalendar = (s: CalendarSettings, hours: WorkingHours | null = null) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays, holidays_rest = excluded.holidays_rest,
           holiday_eves_rest = excluded.holiday_eves_rest, rest_occasions = excluded.rest_occasions, working_hours = excluded.working_hours`,
        [org, s.restWeekdays, s.holidaysRest, s.holidayEvesRest, s.restOccasions, hours === null ? null : JSON.stringify(hours)],
      ),
    );
  const setOrgZone = (zone: string) => asAdmin((q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));
  const setProfile = (user: U, hours: WorkingHours | Record<string, unknown> | null, zone: string | null = null) =>
    asAdmin((q) => q("update public.profiles set working_hours = $2, timezone = $3 where id = $1", [user.id, hours === null ? null : JSON.stringify(hours), zone]));
  const inHours = (user: U, at: string) =>
    asAdmin(async (q) => (await q<{ ok: boolean }>("select app.member_in_hours($1, $2, $3) as ok", [org, user.id, at])).rows[0].ok);
  const nextOwner = (at: string, teamId: string | null = team) =>
    asAdmin(async (q) => (await q<{ id: string | null }>("select app.next_lead_owner($1, $2, $3) as id", [org, teamId, at])).rows[0].id);
  const setAvailable = (user: U, on: boolean) =>
    asAdmin((q) => q("update public.memberships set is_available = $3 where organization_id = $1 and user_id = $2", [org, user.id, on]));

  beforeAll(async () => {
    owner = await createUser("wh-owner");
    org = await createOrg(owner.id, "עסק השעות");
    admin = await addMember(org, owner.id, "admin", "wh-admin");
    admin2 = await addMember(org, owner.id, "admin", "wh-admin2");
    rep1 = await addMember(org, owner.id, "member", "wh-rep1");
    rep2 = await addMember(org, owner.id, "member", "wh-rep2");
    rep3 = await addMember(org, owner.id, "member", "wh-rep3");
    viewer = await addMember(org, owner.id, "viewer", "wh-viewer");
    outsider = await createUser("wh-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      for (const user of [rep1, rep2, rep3]) {
        await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, user.id]);
      }
    });
  });

  it("no hours set anywhere: no limit at any hour, rest days and holidays included (as before CAP-09)", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    await setOrgZone("Asia/Jerusalem");
    await setProfile(rep1, null);
    expect(await inHours(rep1, "2026-10-18T00:00:00Z")).toBe(true); // Sunday 03:00 in Israel
    expect(await inHours(rep1, "2026-10-16T08:00:00Z")).toBe(true); // Friday, a rest day
    expect(await inHours(rep1, "2026-09-21T08:00:00Z")).toBe(true); // Yom Kippur
    // a leave still counts
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-10-18', '2026-10-18')", [org, rep1.id]));
    expect(await inHours(rep1, "2026-10-18T00:00:00Z")).toBe(false);
    await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01' where organization_id = $1", [org]));
  });

  it("the business's hours, once set, count in its zone and close its rest days", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS, EIGHT_TO_SIX);
    await setOrgZone("Asia/Jerusalem");
    await setProfile(rep1, null);
    // Sunday 18 October 2026, Israel is UTC+3
    expect(await inHours(rep1, "2026-10-18T05:00:00Z")).toBe(true); // 08:00
    expect(await inHours(rep1, "2026-10-18T04:59:59Z")).toBe(false); // 07:59:59
    expect(await inHours(rep1, "2026-10-18T14:59:59Z")).toBe(true); // 17:59:59
    expect(await inHours(rep1, "2026-10-18T15:00:00Z")).toBe(false); // 18:00
    // Friday 16 October: a rest day by default, though the hours list Friday
    expect(await inHours(rep1, "2026-10-16T08:00:00Z")).toBe(false);
    // Yom Kippur, Monday 21 September 2026: a holiday that is a rest day
    expect(await inHours(rep1, "2026-09-21T08:00:00Z")).toBe(false);
    await setCalendar({ ...DEFAULT_CALENDAR_SETTINGS, holidaysRest: false }, EIGHT_TO_SIX);
    expect(await inHours(rep1, "2026-09-21T08:00:00Z")).toBe(true);
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
  });

  it("time zones around midnight: the person's own hours in their zone, rest days by the business's date", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    await setOrgZone("Asia/Jerusalem");
    // Sunday evening hours, read in Israel
    await setProfile(rep1, { sun: [{ start: "22:00", end: "23:59" }] });
    expect(await inHours(rep1, "2026-10-18T20:30:00Z")).toBe(true); // Sunday 23:30 in Israel
    expect(await inHours(rep1, "2026-10-18T20:59:59Z")).toBe(true); // 23:59:59: a range ending 23:59 runs to midnight
    expect(await inHours(rep1, "2026-10-18T21:30:00Z")).toBe(false); // Monday 00:30 in Israel, still Sunday in UTC
    // Saturday night in UTC is already Sunday in Israel: not a rest day
    await setProfile(rep1, ALL_DAY);
    expect(await inHours(rep1, "2026-10-17T21:30:00Z")).toBe(true);
    expect(await inHours(rep1, "2026-10-17T20:30:00Z")).toBe(false); // Saturday 23:30 in Israel
    // the same hours in New York: Sunday 23:30 there is Monday morning in Israel
    await setProfile(rep1, { sun: [{ start: "22:00", end: "23:59" }] }, "America/New_York");
    expect(await inHours(rep1, "2026-10-19T03:30:00Z")).toBe(true);
    expect(await inHours(rep1, "2026-10-18T20:30:00Z")).toBe(false); // 16:30 in New York
    // the first stored shape (one range object per day) still counts
    await setProfile(rep1, { mon: { start: "09:00", end: "10:00" } });
    expect(await inHours(rep1, "2026-10-19T06:30:00Z")).toBe(true);
    // no working day at all: never in hours
    await setProfile(rep1, {});
    expect(await inHours(rep1, "2026-10-19T06:30:00Z")).toBe(false);
    await setProfile(rep1, null);
  });

  it("a day of leave is outside hours, both ends included, in the person's zone", async () => {
    await setCalendar(ALWAYS_OPEN, ALL_DAY);
    await setOrgZone("Asia/Jerusalem");
    await setProfile(rep2, null, "Asia/Tokyo");
    await asUser(rep2.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-10-20', '2026-10-21')", [org, rep2.id]));
    expect(await inHours(rep2, "2026-10-19T14:59:00Z")).toBe(true); // 23:59 on the 19th in Tokyo
    expect(await inHours(rep2, "2026-10-19T15:00:00Z")).toBe(false); // the 20th in Tokyo
    expect(await inHours(rep2, "2026-10-21T14:59:00Z")).toBe(false);
    expect(await inHours(rep2, "2026-10-21T15:00:00Z")).toBe(true); // the 22nd in Tokyo
    await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01' where organization_id = $1", [org]));
    await setProfile(rep2, null);
  });

  it("matches memberInHours() on a grid of settings, zones, leaves and moments", async () => {
    type Case = { orgZone: string; calendar: CalendarSettings; orgHours: WorkingHours | null; userZone: string | null; userHours: WorkingHours | null; leaves: Leave[] };
    const split: WorkingHours = {
      sun: [{ start: "09:00", end: "13:00" }, { start: "16:00", end: "20:00" }],
      mon: [{ start: "09:00", end: "13:00" }, { start: "16:00", end: "20:00" }],
      tue: [{ start: "09:00", end: "13:00" }],
      wed: [{ start: "07:30", end: "23:59" }],
      thu: [{ start: "00:00", end: "06:00" }, { start: "12:00", end: "12:30" }],
      fri: [{ start: "08:00", end: "12:00" }],
    };
    const cases: Case[] = [
      // no hours anywhere: only the leave limits
      { orgZone: "Asia/Jerusalem", calendar: DEFAULT_CALENDAR_SETTINGS, orgHours: null, userZone: null, userHours: null, leaves: [{ startsOn: "2026-10-20", endsOn: "2026-10-21" }] },
      // the person's own hours only: the business's rest days close them
      { orgZone: "Asia/Jerusalem", calendar: DEFAULT_CALENDAR_SETTINGS, orgHours: null, userZone: "Europe/Berlin", userHours: { fri: [{ start: "06:00", end: "23:59" }], sun: [{ start: "10:00", end: "12:00" }] }, leaves: [] },
      { orgZone: "Asia/Jerusalem", calendar: DEFAULT_CALENDAR_SETTINGS, orgHours: EIGHT_TO_SIX, userZone: null, userHours: null, leaves: [] },
      { orgZone: "Asia/Jerusalem", calendar: { restWeekdays: [6], holidaysRest: true, holidayEvesRest: true, restOccasions: ["chol_hamoed_sukkot"] }, orgHours: split, userZone: null, userHours: null, leaves: [] },
      { orgZone: "Asia/Jerusalem", calendar: DEFAULT_CALENDAR_SETTINGS, orgHours: split, userZone: "America/New_York", userHours: { mon: [{ start: "22:00", end: "23:59" }], tue: [{ start: "00:00", end: "02:00" }] }, leaves: [] },
      { orgZone: "Europe/London", calendar: ALWAYS_OPEN, orgHours: ALL_DAY, userZone: "Asia/Tokyo", userHours: null, leaves: [{ startsOn: "2026-10-20", endsOn: "2026-10-21" }, { startsOn: "2026-10-24", endsOn: "2026-10-24" }] },
      { orgZone: "America/Los_Angeles", calendar: { restWeekdays: [0], holidaysRest: false, holidayEvesRest: false, restOccasions: [] }, orgHours: split, userZone: null, userHours: null, leaves: [{ startsOn: "2026-10-22", endsOn: "2026-10-22" }] },
    ];
    // every 97 minutes from the Sukkot week to the clock changes of late October and early November
    const moments: string[] = [];
    for (let t = Date.parse("2026-10-01T00:00:00Z"); t < Date.parse("2026-11-03T00:00:00Z"); t += 97 * 60_000) {
      moments.push(new Date(t).toISOString());
    }
    const rep = rep3;
    for (const c of cases) {
      await setOrgZone(c.orgZone);
      await setCalendar(c.calendar, c.orgHours);
      await setProfile(rep, c.userHours, c.userZone);
      await asAdmin(async (q) => {
        await q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01' where organization_id = $1 and user_id = $2", [org, rep.id]);
        for (const leave of c.leaves) {
          await q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, $3, $4)", [org, rep.id, leave.startsOn, leave.endsOn]);
        }
      });
      const rows = await asAdmin(
        async (q) =>
          (await q<{ t: Date; ok: boolean }>("select t, app.member_in_hours($1, $2, t) as ok from unnest($3::timestamptz[]) t", [org, rep.id, moments])).rows,
      );
      const sql = rows.map((r) => `${r.t.toISOString()} ${r.ok}`);
      const ts = moments.map((m) => `${m} ${memberInHours({ at: new Date(m), orgTimeZone: c.orgZone, calendar: c.calendar, orgHours: c.orgHours, userTimeZone: c.userZone, userHours: c.userHours, leaves: c.leaves })}`);
      expect(sql, JSON.stringify(c)).toEqual(ts);
      // the grid is not trivial
      expect(new Set(rows.map((r) => r.ok)).size, JSON.stringify(c)).toBe(2);
    }
    await setOrgZone("Asia/Jerusalem");
    await setProfile(rep, null);
  });

  it("the round robin picks a member in hours and skips one outside hours or on leave", async () => {
    await setOrgZone("Asia/Jerusalem");
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    // Sunday 18 October 2026 10:00 in Israel
    const at = "2026-10-18T07:00:00Z";
    await setProfile(rep1, null);
    await setProfile(rep2, { sun: [{ start: "14:00", end: "18:00" }] }); // starts later
    await setProfile(rep3, null);
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-10-18', '2026-10-18')", [org, rep3.id]));
    const picked = new Set<string | null>();
    for (let i = 0; i < 4; i++) picked.add(await nextOwner(at));
    expect(picked).toEqual(new Set([rep1.id]));
    // at 15:00 rep2 is in hours too, rep3 is still on leave
    const later = new Set<string | null>();
    for (let i = 0; i < 4; i++) later.add(await nextOwner("2026-10-18T12:00:00Z"));
    expect(later).toEqual(new Set([rep1.id, rep2.id]));
    // the manual "available" switch still applies
    await setAvailable(rep1, false);
    expect(await nextOwner(at)).toBeNull();
    await setAvailable(rep1, true);
  });

  it("with hours set: on a rest day, or when nobody is in hours, nobody is picked", async () => {
    await setOrgZone("Asia/Jerusalem");
    await setCalendar(DEFAULT_CALENDAR_SETTINGS, EIGHT_TO_SIX);
    await setProfile(rep2, ALL_DAY);
    // Saturday 17 October: closed, even for someone whose own hours cover it
    expect(await nextOwner("2026-10-17T09:00:00Z")).toBeNull();
    // Sunday 03:00 in Israel: outside everybody's hours
    await setProfile(rep2, null);
    expect(await nextOwner("2026-10-18T00:00:00Z")).toBeNull();
    // without a team, the whole organization: the owner and the admin are outside hours too
    expect(await nextOwner("2026-10-18T00:00:00Z", null)).toBeNull();
    // without hours the round robin works around the clock and on rest days, as before
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    expect(await nextOwner("2026-10-17T09:00:00Z")).not.toBeNull();
    expect(await nextOwner("2026-10-18T00:00:00Z")).not.toBeNull();
  });

  it("intake: a lead goes round robin to whoever is in hours now; with nobody in hours it waits with no owner", async () => {
    // always open; rep1 has no working day, rep2 is on leave today, rep3 is in hours
    await setCalendar(ALWAYS_OPEN, ALL_DAY);
    await setProfile(rep1, {});
    await setProfile(rep2, null);
    await setProfile(rep3, null);
    await asAdmin((q) => q("update public.member_leaves set starts_on = '2000-01-01', ends_on = '2000-01-01' where organization_id = $1", [org]));
    await asAdmin((q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, current_date - 1, current_date + 1)", [org, rep2.id]));
    const form = await asUser(owner.id, async (q) =>
      (await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id) values ($1, 'webhook', 'סבב שעות', $2, 'round_robin', $3) returning token", [org, owner.id, team])).rows[0],
    );
    const submit = (phone: string) =>
      asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [form.token, JSON.stringify({ full_name: "פונה", phone })])).rows[0].r.lead_id);
    const ownerOf = (lead: string) => asAdmin(async (q) => (await q<{ owner_id: string }>("select owner_id from public.leads where id = $1", [lead])).rows[0].owner_id);
    for (const phone of ["050-9100001", "050-9100002", "050-9100003"]) {
      expect(await ownerOf(await submit(phone))).toBe(rep3.id);
    }
    // today is a rest day of the business: nobody is in hours, nobody owns it (owner, 13 October 2026)
    await asAdmin((q) =>
      q(
        `update public.org_calendar_settings set rest_weekdays = array[extract(dow from (now() at time zone 'Asia/Jerusalem'))::smallint]
          where organization_id = $1`,
        [org],
      ),
    );
    expect(await ownerOf(await submit("050-9100004"))).toBeNull();
    await setCalendar(ALWAYS_OPEN, ALL_DAY);
    // rep3 outside hours too: nobody owns it
    await setProfile(rep3, {});
    expect(await ownerOf(await submit("050-9100005"))).toBeNull();
    await setProfile(rep1, null);
    await setProfile(rep3, null);
  });

  it("the hours function and the dated round robin are not reachable from the API", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select app.member_in_hours($1, $2, now())", [org, rep1.id])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.next_lead_owner($1, null, now())", [org])))).code).toBe("42501");
  });

  it("leave: a member writes their own, the owner anyone's, an admin all but the owner's and other admins', a member never another's", async () => {
    const add = (actor: U, user: U) =>
      asUser(actor.id, async (q) =>
        (await q<{ id: string }>("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-12-01', '2026-12-03') returning id", [org, user.id])).rows[0].id,
      );
    const own = await add(rep1, rep1);
    expect((await pgError(add(rep1, rep2))).code).toBe("42501");
    const byAdmin = await add(admin, rep2);
    const byOwner = await add(owner, admin);
    // the creator is stamped from the session
    expect(await asAdmin(async (q) => (await q<{ c: string }>("select created_by as c from public.member_leaves where id = $1", [byAdmin])).rows[0].c)).toBe(admin.id);
    // an admin does not set the owner's or another admin's leave; the owner sets anyone's
    expect((await pgError(add(admin, owner))).code).toBe("42501");
    expect((await pgError(add(admin, admin2))).code).toBe("42501");
    const ownersAdmin2 = await add(owner, admin2);
    expect(await asUser(admin.id, async (q) => (await q("update public.member_leaves set ends_on = '2026-12-09' where id = $1", [ownersAdmin2])).rowCount)).toBe(0);
    const ownersOwn = await add(owner, owner);
    expect(await asUser(admin.id, async (q) => (await q("delete from public.member_leaves where id = $1", [ownersOwn])).rowCount)).toBe(0);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.member_leaves where id = $1", [ownersOwn])).rowCount)).toBe(1);
    expect(await asUser(admin2.id, async (q) => (await q("delete from public.member_leaves where id = $1", [ownersAdmin2])).rowCount)).toBe(1);
    // a viewer may note their own leave
    await add(viewer, viewer);
    // an outsider cannot add one for a member of this organization, nor for themselves here
    expect((await pgError(add(outsider, rep1))).code).toBe("42501");
    expect((await pgError(add(outsider, outsider))).code).toMatch(/42501|23503/);
    // nor, in their own organization, a leave for someone who is not a member there
    const foreign = await pgError(
      asUser(outsider.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2026-12-01', '2026-12-01')", [otherOrg, rep1.id])),
    );
    expect(foreign.code).toBe("23503");

    await asUser(rep2.id, async (q) => {
      expect((await q("update public.member_leaves set ends_on = '2026-12-09' where id = $1", [own])).rowCount).toBe(0);
      expect((await q("delete from public.member_leaves where id = $1", [own])).rowCount).toBe(0);
      // colleagues see the dates
      expect(await count(q, "select 1 from public.member_leaves where id = $1", [own])).toBe(1);
      expect((await q("update public.member_leaves set ends_on = '2026-12-05' where id = $1", [byAdmin])).rowCount).toBe(1);
    });
    await asUser(admin.id, async (q) => {
      expect((await q("update public.member_leaves set ends_on = '2026-12-04' where id = $1", [own])).rowCount).toBe(1);
    });
    // the range: end before start, or longer than a year, is refused
    expect((await pgError(asUser(rep1.id, (q) => q("update public.member_leaves set ends_on = '2026-11-01' where id = $1", [own])))).code).toBe("23514");
    expect((await pgError(asUser(rep1.id, (q) => q("update public.member_leaves set ends_on = '2028-01-01' where id = $1", [own])))).code).toBe("23514");
    // a member cannot move a leave to someone else
    expect((await pgError(asUser(rep1.id, (q) => q("update public.member_leaves set user_id = $2 where id = $1", [own, rep2.id])))).code).toBe("42501");
    expect(await asUser(rep1.id, async (q) => (await q("delete from public.member_leaves where id = $1", [own])).rowCount)).toBe(1);
    // byOwner is the admin's own leave: the admin removes it
    expect(await asUser(admin.id, async (q) => (await q("delete from public.member_leaves where id = $1 and user_id = $2", [byOwner, admin.id])).rowCount)).toBe(1);
    // audited
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'member_leaves'", [org]))).toBeGreaterThan(0);
  });

  it("leave: at most 100 current and future per member (past ones do not count), and a read-only organization changes nothing", async () => {
    const insertAs = (start: string, end: string) =>
      asUser(viewer.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, $3::date, $4::date)", [org, viewer.id, start, end]));
    // "current or future" is judged from the business's own today, as app.member_leaves_limit does: ends on or after the day
    // before it. Every date that must count is taken from that day, so the test holds on any date and at any hour.
    const cutoffSql = "(select (now() at time zone app.intake_zone(o.timezone))::date - 1 from public.organizations o where o.id = $1)";
    const day = async (offset: number) =>
      asAdmin(async (q) => (await q<{ d: string }>(`select (${cutoffSql} + 1 + $2::int)::text as d`, [org, offset])).rows[0].d);
    const [filler, first, firstEnd, over, overEnd, movedFrom, movedTo] = await Promise.all([150, 60, 61, 64, 65, 240, 241].map(day));
    await asAdmin(async (q) => {
      // 150 leaves that ended long ago, and one that ended two days ago: none of them counts
      for (let i = 0; i < 150; i++) {
        await q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, '2025-01-01', '2025-01-01')", [org, viewer.id]);
      }
      await q(`insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, ${cutoffSql} - 4, ${cutoffSql} - 1)`, [org, viewer.id]);
      const have = await count(q, `select 1 from public.member_leaves where organization_id = $1 and user_id = $2 and ends_on >= ${cutoffSql}`, [org, viewer.id]);
      for (let i = have; i < 99; i++) {
        await q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, $3::date, $3::date)", [org, viewer.id, filler]);
      }
    });
    // the 100th current or future one is still allowed, the 101st is not
    await insertAs(first, firstEnd);
    const err = await pgError(insertAs(over, overEnd));
    expect(err).toMatchObject({ code: "P0001", hint: "member_leaves:max" });
    // a past one does not count, but the cap is about how many are current or future
    expect((await pgError(insertAs("2025-02-01", "2025-02-02"))).hint).toBe("member_leaves:max");
    // moving an old leave into the future counts too; changing it inside the past does not
    const old = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.member_leaves where organization_id = $1 and user_id = $2 and ends_on = '2025-01-01' limit 1", [org, viewer.id])).rows[0].id);
    const moved = await pgError(asUser(viewer.id, (q) => q("update public.member_leaves set starts_on = $2::date, ends_on = $3::date where id = $1", [old, movedFrom, movedTo])));
    expect(moved).toMatchObject({ code: "P0001", hint: "member_leaves:max" });
    expect(await asUser(viewer.id, async (q) => (await q("update public.member_leaves set starts_on = '2024-12-30', ends_on = '2024-12-31' where id = $1", [old])).rowCount)).toBe(1);
    // a current or future one may still change its dates at the cap
    const future = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.member_leaves where organization_id = $1 and user_id = $2 and ends_on = $3::date limit 1", [org, viewer.id, filler])).rows[0].id);
    expect(await asUser(viewer.id, async (q) => (await q("update public.member_leaves set ends_on = ends_on + 1 where id = $1", [future])).rowCount)).toBe(1);

    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      const add = await pgError(asUser(rep1.id, (q) => q("insert into public.member_leaves (organization_id, user_id, starts_on, ends_on) values ($1, $2, $3::date, $4::date)", [org, rep1.id, first, firstEnd])));
      expect(add.code).toBe("42501");
      expect(await asUser(owner.id, async (q) => (await q("update public.member_leaves set ends_on = ends_on where organization_id = $1", [org])).rowCount)).toBe(0);
      const hours = await pgError(asUser(owner.id, (q) => q("select public.set_member_working_hours($1, $2, null)", [org, rep1.id])));
      expect(hours).toMatchObject({ code: "P0001", hint: "org:read_only" });
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
  });

  it("working hours: the business's are set by owners and admins only; a member sets their own", async () => {
    await setCalendar(DEFAULT_CALENDAR_SETTINGS);
    const hours = JSON.stringify({ sun: [{ start: "09:00", end: "17:00" }] });
    expect(await asUser(rep1.id, async (q) => (await q("update public.org_calendar_settings set working_hours = $2 where organization_id = $1", [org, hours])).rowCount)).toBe(0);
    expect(await asUser(admin.id, async (q) => (await q("update public.org_calendar_settings set working_hours = $2 where organization_id = $1", [org, hours])).rowCount)).toBe(1);
    const bad = await pgError(asUser(admin.id, (q) => q("update public.org_calendar_settings set working_hours = '{\"sun\": [{\"start\": \"18:00\", \"end\": \"09:00\"}]}' where organization_id = $1", [org])));
    expect(bad.code).toBe("23514");
    // a member edits their own profile hours, never a colleague's
    expect(await asUser(rep1.id, async (q) => (await q("update public.profiles set working_hours = $2 where id = $1", [rep1.id, hours])).rowCount)).toBe(1);
    expect(await asUser(rep1.id, async (q) => (await q("update public.profiles set working_hours = $2 where id = $1", [rep2.id, hours])).rowCount)).toBe(0);
  });

  it("set_member_working_hours: the owner sets anyone's, an admin all but the owner and other admins, members of this organization only, logged", async () => {
    const hours = { mon: [{ start: "10:00", end: "14:00" }] };
    const set = (actor: U, user: U, value: unknown) =>
      asUser(actor.id, (q) => q("select public.set_member_working_hours($1, $2, $3)", [org, user.id, value === null ? null : JSON.stringify(value)]));
    expect((await pgError(set(rep1, rep2, hours))).code).toBe("42501");
    expect((await pgError(set(outsider, rep2, hours))).code).toBe("42501");
    await set(admin, rep2, hours);
    expect(await asAdmin(async (q) => (await q<{ h: unknown }>("select working_hours as h from public.profiles where id = $1", [rep2.id])).rows[0].h)).toEqual(hours);
    expect(
      await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'profiles' and entity_id = $2 and changes ? 'working_hours'", [org, rep2.id])),
    ).toBe(1);
    await set(owner, rep2, null);
    expect(await asAdmin(async (q) => (await q<{ h: unknown }>("select working_hours as h from public.profiles where id = $1", [rep2.id])).rows[0].h)).toBeNull();
    // invalid hours
    expect(await pgError(set(admin, rep2, { sun: [{ start: "12:00", end: "11:00" }] }))).toMatchObject({ code: "P0001", hint: "member_hours:invalid" });
    // an admin does not change the owner's or another admin's hours; the owner changes anyone's; anyone their own
    expect((await pgError(set(admin, owner, hours))).code).toBe("42501");
    expect((await pgError(set(admin, admin2, hours))).code).toBe("42501");
    await set(owner, admin2, hours);
    await set(admin, admin, hours);
    await set(owner, admin2, null);
    await set(admin, admin, null);
    // not a member here
    expect((await pgError(set(admin, outsider, hours))).code).toBe("42501");
    // a member of another organization too: only they change their shared profile
    const token = await asUser(outsider.id, async (q) => (await q<{ token: string }>("select public.create_invitation($1, $2, 'member') as token", [otherOrg, rep3.email])).rows[0].token);
    await asUser(rep3.id, (q) => q("select public.accept_invitation($1)", [token]));
    expect(await pgError(set(admin, rep3, hours))).toMatchObject({ code: "P0001", hint: "member_hours:other_orgs" });
  });
});

// Owner's answer of 13 October 2026 (DECISIONS.md, CAP-09): a lead that comes in while
// the rotation has members but none in hours waits with no owner for a "לקחתי", and goes
// to the first member back in hours if nobody took it.
describe("a lead while the rotation is out of hours (CAP-09)", () => {
  let owner: U, rep1: U, rep2: U;
  let org: string;
  let team: string;
  let token: string;

  const setOrgHours = (hours: WorkingHours | Record<string, never>) =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, working_hours) values ($1, '{}', false, $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, working_hours = excluded.working_hours`,
        [org, JSON.stringify(hours)],
      ),
    );
  const submit = (phone: string) =>
    asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [token, JSON.stringify({ full_name: "פונה בלילה", phone })])).rows[0].r.lead_id);
  const ownerOf = (lead: string) => asAdmin(async (q) => (await q<{ owner_id: string | null }>("select owner_id from public.leads where id = $1", [lead])).rows[0].owner_id);
  // The job runs over every business. Leads other tests left waiting are given out whenever their own people's hours are open,
  // which depends on the hour and the weekday the suite runs at; they sit this run out (and get their times back after it),
  // so the count is this business's alone, at any time.
  const runWaiting = () =>
    asAdmin(async (q) => {
      await q(
        "create temp table other_waiting on commit drop as select lead_id, next_check_at from app.rotation_waiting_leads where resolved_at is null and organization_id <> $1",
        [org],
      );
      await q("update app.rotation_waiting_leads w set next_check_at = 'infinity' from other_waiting o where w.lead_id = o.lead_id");
      const n = (await q<{ n: number }>("select app.assign_waiting_rotation_leads() as n")).rows[0].n;
      await q("update app.rotation_waiting_leads w set next_check_at = o.next_check_at from other_waiting o where w.lead_id = o.lead_id");
      return n;
    });
  const pointer = (user: U) =>
    asAdmin(async (q) => (await q<{ t: Date | null }>("select last_lead_assigned_at as t from public.memberships where organization_id = $1 and user_id = $2", [org, user.id])).rows[0].t?.toISOString() ?? null);
  const setAvailable = (user: U, on: boolean) =>
    asAdmin((q) => q("update public.memberships set is_available = $3 where organization_id = $1 and user_id = $2", [org, user.id, on]));

  beforeAll(async () => {
    owner = await createUser("rw-owner");
    org = await createOrg(owner.id, "עסק הלילה");
    rep1 = await addMember(org, owner.id, "member", "rw-rep1");
    rep2 = await addMember(org, owner.id, "member", "rw-rep2");
    await asUser(owner.id, async (q) => {
      team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      for (const user of [rep1, rep2]) {
        await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, user.id]);
      }
      token = (
        await q<{ token: string }>(
          "insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id) values ($1, 'webhook', 'סבב לילה', $2, 'round_robin', $3) returning token",
          [org, owner.id, team],
        )
      ).rows[0].token;
    });
  });

  it("nobody of the rotation in hours: the lead stays with no owner and the team is told, with 'לקחתי'", async () => {
    // hours set with no working day: nobody is ever in hours
    await setOrgHours({});
    const lead = await submit("052-8100001");
    expect(await ownerOf(lead)).toBeNull();
    const notes = await asAdmin(
      async (q) => (await q<{ user_id: string; type: string }>("select user_id, type from public.notifications where entity_id = $1 order by user_id", [lead])).rows,
    );
    expect(new Set(notes.map((n) => n.user_id))).toEqual(new Set([rep1.id, rep2.id]));
    expect(notes.every((n) => n.type === "lead_new")).toBe(true);
    expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where lead_id = $1 and resolved_at is null", [lead]))).toBe(1);
    // nobody back in hours yet: it keeps waiting
    expect(await runWaiting()).toBe(0);
    expect(await ownerOf(lead)).toBeNull();
  });

  it("nobody available at all: the form owner's fallback, as before", async () => {
    await setOrgHours({});
    await setAvailable(rep1, false);
    await setAvailable(rep2, false);
    try {
      const lead = await submit("052-8100002");
      expect(await ownerOf(lead)).toBe(owner.id);
      expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where lead_id = $1", [lead]))).toBe(0);
    } finally {
      await setAvailable(rep1, true);
      await setAvailable(rep2, true);
    }
  });

  it("a 'לקחתי' outside hours does not move the rotation pointer, and the taken lead is left alone later", async () => {
    await setOrgHours({});
    const lead = await submit("052-8100003");
    const before = await pointer(rep1);
    const taken = await asUser(rep1.id, async (q) => (await q<{ r: { ok: boolean } }>("select public.take_lead($1, $2) as r", [org, lead])).rows[0].r);
    expect(taken.ok).toBe(true);
    expect(await ownerOf(lead)).toBe(rep1.id);
    expect(await pointer(rep1)).toBe(before);
    // back in hours: the taken lead is not reassigned, only resolved
    await setOrgHours(ALL_DAY);
    await runWaiting();
    expect(await ownerOf(lead)).toBe(rep1.id);
    expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where lead_id = $1 and resolved_at is not null and assigned_to is null", [lead]))).toBe(1);
  });

  it("nobody took it: once a member is back in hours the rotation gives it to the next in line, with a notification", async () => {
    await setOrgHours({});
    const lead = await submit("052-8100004");
    expect(await ownerOf(lead)).toBeNull();
    await setOrgHours(ALL_DAY);
    expect(await runWaiting()).toBeGreaterThanOrEqual(1);
    const assigned = await ownerOf(lead);
    expect([rep1.id, rep2.id]).toContain(assigned);
    expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_id = $1 and user_id = $2 and type = 'assigned'", [lead, assigned]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where lead_id = $1 and assigned_to = $2", [lead, assigned]))).toBe(1);
    // the pointer moved for the one who got it, as in the normal rotation
    expect(await pointer({ id: assigned!, email: "" })).not.toBeNull();
    // and nothing is left waiting
    expect(await runWaiting()).toBe(0);
  });

  it("the waiting list and the job are not reachable from the API", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("select 1 from app.rotation_waiting_leads")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.assign_waiting_rotation_leads()")))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("select app.rotation_has_members($1, null)", [org])))).code).toBe("42501");
  });
});

// Review M1: the job is fair between organizations and bounded per run.
describe("the waiting-lead job is fair between organizations (CAP-09)", () => {
  type Org = { owner: U; rep: U; org: string; token: string };
  const makeOrg = async (label: string): Promise<Org> => {
    const owner = await createUser(`${label}-owner`);
    const org = await createOrg(owner.id, `עסק ${label}`);
    const rep = await addMember(org, owner.id, "member", `${label}-rep`);
    const token = await asUser(owner.id, async (q) => {
      const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id) values ($1, $2, $3)", [org, team, rep.id]);
      return (
        await q<{ token: string }>("insert into public.forms (organization_id, kind, name, owner_id, assign_mode, team_id) values ($1, 'webhook', 'סבב', $2, 'round_robin', $3) returning token", [org, owner.id, team])
      ).rows[0].token;
    });
    return { owner, rep, org, token };
  };
  const setHours = (o: Org, hours: WorkingHours | Record<string, never>) =>
    asUser(o.owner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, working_hours) values ($1, '{}', false, $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, working_hours = excluded.working_hours`,
        [o.org, JSON.stringify(hours)],
      ),
    );
  const submit = (o: Org, phone: string) =>
    asService(async (q) => (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'webhook', $2) as r", [o.token, JSON.stringify({ full_name: "פונה", phone })])).rows[0].r.lead_id);

  it("org A has more waiting leads than the run's limit, and org B's lead is still given out in the same run", async () => {
    const a = await makeOrg("fair-a");
    const b = await makeOrg("fair-b");
    await setHours(a, {});
    await setHours(b, {});
    for (let i = 0; i < 6; i++) await submit(a, `053-81000${10 + i}`);
    const bLead = await submit(b, "053-8100099");
    await setHours(b, ALL_DAY);
    const n = await asAdmin(async (q) => {
      // other tests' waiting rows wait for later; this run sees A's and B's only
      await q("update app.rotation_waiting_leads set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> all ($1::uuid[])", [[a.org, b.org]]);
      await q("select set_config('app.rotation_waiting_per_org', '2', true), set_config('app.rotation_waiting_limit', '3', true)");
      return (await q<{ n: number }>("select app.assign_waiting_rotation_leads() as n")).rows[0].n;
    });
    expect(n).toBe(1);
    expect(await asAdmin(async (q) => (await q<{ o: string }>("select owner_id as o from public.leads where id = $1", [bLead])).rows[0].o)).toBe(b.rep.id);
    // A's two looked-at rows wait a minute; its other four were not looked at
    const pushed = await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where organization_id = $1 and resolved_at is null and next_check_at > now()", [a.org]));
    expect(pushed).toBe(2);
    expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where organization_id = $1 and resolved_at is null", [a.org]))).toBe(6);
    // a row of an organization that turned read-only waits 15 minutes
    await setHours(a, ALL_DAY);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [a.org]));
    try {
      await asAdmin(async (q) => {
        await q("update app.rotation_waiting_leads set next_check_at = now() where organization_id = $1 and resolved_at is null", [a.org]);
        await q("select app.assign_waiting_rotation_leads()");
      });
      expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where organization_id = $1 and resolved_at is null and next_check_at > now() + interval '10 minutes'", [a.org]))).toBeGreaterThan(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [a.org]));
    }
  });

  it("one lead that fails does not stop the run: it waits 10 minutes, the others are given out", async () => {
    const c = await makeOrg("fair-c");
    await setHours(c, {});
    const bad = await submit(c, "053-8200001");
    const good = await submit(c, "053-8200002");
    await setHours(c, ALL_DAY);
    await asAdmin(async (q) => {
      await q("update app.rotation_waiting_leads set next_check_at = now() + interval '1 hour' where resolved_at is null and organization_id <> $1", [c.org]);
      // a test-only trigger that refuses the update of one lead
      await q(`create function pg_temp.refuse_lead() returns trigger language plpgsql as $f$
               begin if new.id = '${bad}' then raise exception 'refused for the test'; end if; return new; end $f$`);
      await q("create trigger zz_test_refuse before update on public.leads for each row execute function pg_temp.refuse_lead()");
      const n = (await q<{ n: number }>("select app.assign_waiting_rotation_leads() as n")).rows[0].n;
      expect(n).toBe(1);
      await q("drop trigger zz_test_refuse on public.leads");
    });
    expect(await asAdmin(async (q) => (await q<{ o: string | null }>("select owner_id as o from public.leads where id = $1", [good])).rows[0].o)).toBe(c.rep.id);
    expect(await asAdmin(async (q) => (await q<{ o: string | null }>("select owner_id as o from public.leads where id = $1", [bad])).rows[0].o)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from app.rotation_waiting_leads where lead_id = $1 and resolved_at is null and next_check_at > now() + interval '9 minutes'", [bad]))).toBe(1);
  });
});

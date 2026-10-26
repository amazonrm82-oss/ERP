import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();

/**
 * GAP-07 (owner, 18 October 2026): a recurring personal block is a CAL-09 meeting series of block rows, made by
 * public.create_meeting_series in one transaction (migration *_block_series.sql). Every occurrence is an ordinary block:
 * the booking page does not offer it, meeting_busy and the calendar feed see it, and every other block rule still holds.
 * The business keeps UTC and works every day 09-17, so nothing depends on the hour or the weekday.
 */
describe("recurring blocked time (GAP-07)", () => {
  let owner: U, rep: U, colleague: U, manager: U, outsider: U;
  let org: string, otherOrg: string;
  let pageToken: string;
  const days = [7, 14, 21, 28].map((n) => dayAhead(n + 2));

  const BLOCK = { title: "חדר כושר", meeting_type: "other", reminder_minutes: null, buffer_before_minutes: 0, buffer_after_minutes: 0, is_block: true };
  const times = (hhmm: [string, string], list = days) => list.map((d) => ({ starts_at: at(d, hhmm[0]), ends_at: at(d, hhmm[1]) }));
  const series = (who: U, fields: Record<string, unknown>, list: Array<{ starts_at: string; ends_at: string }>, orgId = org) =>
    asUser(who.id, async (q) =>
      (await q<{ r: { series_id: string; ids: string[] } }>("select public.create_meeting_series($1, $2, $3, '{}'::uuid[]) as r", [orgId, fields, JSON.stringify(list)])).rows[0]
        .r,
    );
  const slots = async (day: string) =>
    (
      (await asService(async (q) => (await q<{ r: { slots?: string[] } }>("select public.booking_page_public($1, $2) as r", [pageToken, day])).rows[0].r)).slots ?? []
    )
      .map((s) => new Date(s).toISOString())
      .filter((s) => s.startsWith(day));

  beforeAll(async () => {
    owner = await createUser("bs-owner");
    org = await createOrg(owner.id, "עסק החסימות החוזרות");
    rep = await addMember(org, owner.id, "member", "bs-rep");
    colleague = await addMember(org, owner.id, "member", "bs-colleague");
    manager = await addMember(org, owner.id, "manager", "bs-manager");
    outsider = await createUser("bs-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'UTC' where id = $1", [org]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [org, JSON.stringify(ALL_WEEK)],
      );
      // the manager manages the rep's team
      const team = (await q<{ id: string }>("insert into public.teams (organization_id, name) values ($1, 'מכירות') returning id", [org])).rows[0].id;
      await q("insert into public.team_members (organization_id, team_id, user_id, is_manager) values ($1, $2, $3, false), ($1, $2, $4, true)", [
        org,
        team,
        rep.id,
        manager.id,
      ]);
    });
    const type = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.meeting_types (organization_id, name, duration_minutes) values ($1, 'שיחה', 60) returning id", [org])).rows[0].id,
    );
    pageToken = await asUser(rep.id, async (q) =>
      (
        await q<{ token: string }>(
          "insert into public.booking_pages (organization_id, user_id, title, meeting_type_id, min_notice_minutes, slot_step_minutes) values ($1, $2, 'תורים', $3, 0, 60) returning token",
          [org, rep.id, type],
        )
      ).rows[0].token,
    );
  });

  it("a weekly series of blocks is made in one call, one block per week, owned by its maker", async () => {
    const made = await series(rep, BLOCK, times(["10:00", "11:00"]));
    expect(made.ids).toHaveLength(4);
    const rows = await asAdmin(async (q) =>
      (
        await q<{ is_block: boolean; series_index: number; owner_id: string; reminder_minutes: number | null; buffer_before_minutes: number; starts_at: Date }>(
          "select is_block, series_index, owner_id, reminder_minutes, buffer_before_minutes, starts_at from public.meetings where organization_id = $1 and series_id = $2 order by series_index",
          [org, made.series_id],
        )
      ).rows,
    );
    expect(rows.map((r) => r.series_index)).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.is_block && r.owner_id === rep.id && r.reminder_minutes === null && r.buffer_before_minutes === 0)).toBe(true);
    expect(rows.map((r) => r.starts_at.toISOString())).toEqual(days.map((d) => at(d, "10:00")));
  });

  it("every occurrence is busy: the booking page skips it, a colleague's planner and the person's own feed see it", async () => {
    for (const day of days) expect(await slots(day)).toContain(at(day, "12:00"));
    const made = await series(rep, { ...BLOCK, title: "צהריים" }, times(["12:00", "13:00"]));
    for (const day of days) {
      const free = await slots(day);
      expect(free).not.toContain(at(day, "12:00"));
      expect(free).toContain(at(day, "13:00"));
      const busy = await asUser(colleague.id, async (q) =>
        (await q<{ meeting_id: string | null }>("select meeting_id from public.meeting_busy($1, $2, $3, $4)", [org, [rep.id], at(day, "12:15"), at(day, "12:45")])).rows,
      );
      expect(busy).toHaveLength(1);
    }
    const token = await asUser(rep.id, async (q) => (await q<{ token: string }>("select public.calendar_feed_create($1) as token", [org])).rows[0].token);
    const feed = await asService(async (q) => (await q<{ feed: { events?: Array<{ id: string }> } }>("select public.calendar_feed_events($1) as feed", [token])).rows[0].feed);
    const inFeed = new Set((feed.events ?? []).map((e) => e.id));
    expect(made.ids.every((id) => inFeed.has(id))).toBe(true);
  });

  it("all or nothing: one bad week leaves no block of the series", async () => {
    const list = times(["14:00", "15:00"]);
    list[2] = { starts_at: at(days[2], "15:00"), ends_at: at(days[2], "14:00") };
    expect((await pgError(series(rep, { ...BLOCK, title: "כמעט" }, list))).code).toBe("23514");
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1 and title = 'כמעט'", [org]))).toBe(0);
    // 2..52, as for meetings
    expect((await pgError(series(rep, { ...BLOCK, title: "אחת" }, times(["14:00", "15:00"], days.slice(0, 1))))).hint).toBe("meeting_series:invalid");
  });

  it("a block series takes no participants; a meeting series still does", async () => {
    const refused = await pgError(
      asUser(rep.id, async (q) =>
        q("select public.create_meeting_series($1, $2, $3, $4::uuid[])", [org, { ...BLOCK, title: "עם משתתף" }, JSON.stringify(times(["17:00", "17:30"])), [colleague.id]]),
      ),
    );
    expect(refused).toMatchObject({ code: "22023", hint: "meeting_series:block_participants" });
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1 and title = 'עם משתתף'", [org]))).toBe(0);
    const meetings = await asUser(rep.id, async (q) =>
      (
        await q<{ r: { ids: string[] } }>("select public.create_meeting_series($1, $2, $3, $4::uuid[]) as r", [
          org,
          { title: "ישיבה", meeting_type: "phone" },
          JSON.stringify(times(["17:00", "17:30"])),
          [colleague.id],
        ])
      ).rows[0].r,
    );
    expect(await asAdmin((q) => count(q, "select 1 from public.meeting_participants where meeting_id = any($1) and user_id = $2", [meetings.ids, colleague.id]))).toBe(4);
  });

  it("a block series is still a block: no record, type, reminder or buffers, never held", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "לקוח", phone: "0501239999", owner_id: rep.id });
    const type = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 limit 1", [org])).rows[0].id);
    for (const extra of [{ lead_id: lead }, { meeting_type_id: type }, { reminder_minutes: 15 }, { buffer_before_minutes: 15 }]) {
      expect((await pgError(series(rep, { ...BLOCK, title: "אסור", ...extra }, times(["15:00", "16:00"])))).code).toBe("23514");
    }
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1 and title = 'אסור'", [org]))).toBe(0);
    const made = await series(rep, { ...BLOCK, title: "סטטוס" }, times(["15:00", "16:00"]));
    expect((await pgError(asUser(rep.id, (q) => q("update public.meetings set status = 'held' where id = $1", [made.ids[1]])))).code).toBe("23514");
    expect((await pgError(asUser(rep.id, (q) => q("update public.meetings set lead_id = $2 where id = $1", [made.ids[1], lead])))).code).toBe("23514");
    // a meeting series without the flag is unchanged: real meetings with their reminder
    const meetings = await series(rep, { title: "טיפול", meeting_type: "phone", reminder_minutes: 15 }, times(["16:00", "16:30"]));
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where id = any($1) and not is_block and reminder_minutes = 15", [meetings.ids]))).toBe(4);
  });

  it("rights stay a block's own: nobody adds to someone's series, names its organizer, or removes it but those allowed today", async () => {
    const made = await series(rep, { ...BLOCK, title: "שלי" }, times(["09:00", "09:30"]));
    // a colleague cannot slip a block into the series
    expect(
      (
        await pgError(
          asUser(colleague.id, (q) =>
            q(
              "insert into public.meetings (organization_id, title, meeting_type, starts_at, ends_at, reminder_minutes, is_block, series_id, series_index) values ($1, 'זר', 'other', $2, $3, null, true, $4, 5)",
              [org, at(dayAhead(40), "09:00"), at(dayAhead(40), "09:30"), made.series_id],
            ),
          ),
        )
      ).hint,
    ).toBe("meeting_series:invalid");
    // only the person themself or an admin names the organizer
    expect((await pgError(series(colleague, { ...BLOCK, title: "בשמו", owner_id: rep.id }, times(["09:30", "10:00"])))).code).toBe("42501");
    const byOwner = await series(owner, { ...BLOCK, title: "בשמו", owner_id: rep.id }, times(["09:30", "10:00"]));
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where id = any($1) and owner_id = $2", [byOwner.ids, rep.id]))).toBe(4);
    // the rep's team manager may remove the rep's blocks but not name the rep as organizer of a new series, so the app
    // refuses a manager's weekday move up front (splitBlocks) instead of failing after the question
    expect(
      (await asUser(manager.id, async (q) => (await q<{ id: string }>("select r as id from public.meetings_removable($1, $2) r", [org, made.ids])).rows)).map((r) => r.id).sort(),
    ).toEqual([...made.ids].sort());
    expect((await pgError(series(manager, { ...BLOCK, title: "של המנהל", owner_id: rep.id }, times(["10:00", "10:30"])))).code).toBe("42501");
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where organization_id = $1 and title = 'של המנהל'", [org]))).toBe(0);
    // a colleague may neither change nor remove the rep's blocks; the rep may
    expect(await asUser(colleague.id, async (q) => (await q<{ id: string }>("select r as id from public.meetings_removable($1, $2) r", [org, made.ids])).rows)).toEqual([]);
    expect(await asUser(colleague.id, async (q) => (await q("delete from public.meetings where id = any($1)", [made.ids])).rowCount)).toBe(0);
    expect(await asUser(colleague.id, async (q) => (await q("update public.meetings set title = 'x' where id = any($1)", [made.ids])).rowCount)).toBe(0);
    expect(await asUser(rep.id, async (q) => (await q("delete from public.meetings where id = any($1)", [made.ids.slice(2)])).rowCount)).toBe(2);
  });

  it("another business sees nothing and cannot make a series in this one", async () => {
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.meetings where organization_id = $1", [org]))).toBe(0);
    expect((await pgError(series(outsider, { ...BLOCK, title: "פריצה" }, times(["11:00", "12:00"]))))).toMatchObject({ code: "42501" });
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where title = 'פריצה'"))).toBe(0);
    // its own series stays in its own business
    const own = await series(outsider, { ...BLOCK, title: "שלו" }, times(["11:00", "12:00"]), otherOrg);
    expect(await asAdmin((q) => count(q, "select 1 from public.meetings where id = any($1) and organization_id = $2", [own.ids, otherOrg]))).toBe(4);
  });
});

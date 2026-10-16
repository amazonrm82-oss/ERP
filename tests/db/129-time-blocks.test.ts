import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const DAY = 86_400_000;
const ALL_WEEK = Object.fromEntries(["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [{ start: "09:00", end: "17:00" }]]));
const dayAhead = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00Z`).toISOString();

/**
 * GAP-07 (first half): blocked time. A block is a meeting row with is_block = true, set on insert only, with no record,
 * type, series, reminder or buffers, never held or no-show. Everything that reads meetings sees the time as taken: the
 * booking page, the conflict warnings. The meeting report leaves blocks out. The business keeps UTC and works every
 * day 09-17, so nothing here depends on the hour or the weekday.
 */
describe("blocked time (GAP-07)", () => {
  let owner: U, rep: U, colleague: U, outsider: U;
  let org: string;
  let pageToken: string;
  const day = dayAhead(3);

  const block = (who: U, fields: Record<string, unknown> = {}) =>
    asUser(who.id, async (q) => {
      const row: Record<string, unknown> = {
        organization_id: org,
        title: "זמן חסום",
        meeting_type: "other",
        starts_at: at(day, "12:00"),
        ends_at: at(day, "13:00"),
        reminder_minutes: null,
        is_block: true,
        ...fields,
      };
      const cols = Object.keys(row);
      return (await q<{ id: string }>(`insert into public.meetings (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, Object.values(row)))
        .rows[0].id;
    });
  const slots = async () =>
    (
      (await asService(async (q) => (await q<{ r: { slots: string[] } }>("select public.booking_page_public($1, $2) as r", [pageToken, day])).rows[0].r)).slots ?? []
    )
      .map((s) => new Date(s).toISOString())
      .filter((s) => s.startsWith(day));

  beforeAll(async () => {
    owner = await createUser("tb-owner");
    org = await createOrg(owner.id, "עסק החסימות");
    rep = await addMember(org, owner.id, "member", "tb-rep");
    colleague = await addMember(org, owner.id, "member", "tb-colleague");
    outsider = await createUser("tb-outsider");
    await createOrg(outsider.id, "עסק אחר");
    await asAdmin(async (q) => {
      await q("update public.organizations set timezone = 'UTC' where id = $1", [org]);
      await q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions, working_hours)
         values ($1, '{}', false, false, '{}', $2)
         on conflict (organization_id) do update set rest_weekdays = '{}', holidays_rest = false, holiday_eves_rest = false, rest_occasions = '{}', working_hours = $2`,
        [org, JSON.stringify(ALL_WEEK)],
      );
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

  it("a person blocks their own time; the booking page stops offering it, and a colleague's planner sees it as busy", async () => {
    const before = await slots();
    expect(before).toContain(at(day, "12:00"));
    const id = await block(rep);
    const after = await slots();
    expect(after).not.toContain(at(day, "12:00"));
    expect(after).toContain(at(day, "11:00"));
    expect(after).toContain(at(day, "13:00"));
    const busy = await asUser(colleague.id, async (q) =>
      (await q<{ meeting_id: string | null }>("select meeting_id from public.meeting_busy($1, $2, $3, $4)", [org, [rep.id], at(day, "12:30"), at(day, "12:45")])).rows,
    );
    expect(busy).toHaveLength(1);
    // a cancelled block frees the time
    await asUser(rep.id, (q) => q("update public.meetings set status = 'cancelled' where id = $1", [id]));
    expect(await slots()).toContain(at(day, "12:00"));
    // and the creator may remove it
    expect(await asUser(rep.id, async (q) => (await q("delete from public.meetings where id = $1", [id])).rowCount)).toBe(1);
  });

  it("a block is never a meeting with a customer: no record, type, series, reminder or buffers, never held or no-show", async () => {
    const lead = await insertLead(rep.id, org, { full_name: "לקוח", phone: "0501230000", owner_id: rep.id });
    const type = await asAdmin(async (q) => (await q<{ id: string }>("select id from public.meeting_types where organization_id = $1 limit 1", [org])).rows[0].id);
    for (const extra of [{ lead_id: lead }, { meeting_type_id: type }, { reminder_minutes: 15 }, { buffer_before_minutes: 15 }, { status: "held" }]) {
      expect((await pgError(block(rep, extra))).code).toBe("23514");
    }
    const id = await block(rep, { starts_at: at(day, "15:00"), ends_at: at(day, "16:00") });
    for (const status of ["held", "no_show"]) {
      expect((await pgError(asUser(rep.id, (q) => q("update public.meetings set status = $2 where id = $1", [id, status])))).code).toBe("23514");
    }
    expect((await pgError(asUser(rep.id, (q) => q("update public.meetings set lead_id = $2 where id = $1", [id, lead])))).code).toBe("23514");
    // set when made, never changed: a block does not become a meeting, nor a meeting a block
    expect((await pgError(asUser(rep.id, (q) => q("update public.meetings set is_block = false where id = $1", [id])))).code).toBe("42501");
    await asUser(rep.id, (q) => q("delete from public.meetings where id = $1", [id]));
  });

  it("the meeting report leaves blocks out", async () => {
    const report = () =>
      asUser(owner.id, async (q) =>
        (
          await q<{ r: { totals: { meetings: number; upcoming: number } } }>("select public.report_meetings($1, $2, $3, null) as r", [
            org,
            at(day, "00:00"),
            at(dayAhead(4), "00:00"),
          ])
        ).rows[0].r,
      );
    const before = (await report()).totals;
    await block(rep, { starts_at: at(day, "09:00"), ends_at: at(day, "10:00") });
    await asUser(rep.id, (q) =>
      q("insert into public.meetings (organization_id, title, meeting_type, starts_at, ends_at) values ($1, 'פגישה אמיתית', 'phone', $2, $3)", [org, at(day, "14:00"), at(day, "14:30")]),
    );
    const after = (await report()).totals;
    expect(after.meetings).toBe(before.meetings + 1);
    expect(after.upcoming).toBe(before.upcoming + 1);
  });

  it("blocks follow the meetings' rights: another business sees none, and the flag cannot be updated by anyone", async () => {
    await block(rep, { starts_at: at(day, "16:00"), ends_at: at(day, "17:00"), title: "חסום אחר הצהריים" });
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.meetings where is_block"))).toBe(0);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.meetings where organization_id = $1 and is_block and title = 'חסום אחר הצהריים'", [org]))).toBe(1);
    expect((await pgError(asUser(owner.id, (q) => q("update public.meetings set is_block = true where organization_id = $1", [org])))).code).toBe("42501");
  });
});

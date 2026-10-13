import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEFAULT_CALENDAR_SETTINGS, hebrewDate, holidaysOn, isRestDay, type CalendarSettings } from "@/features/calendar-days/holidays";
import { addDays } from "@/lib/calendar-grid";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type Offer = { now: boolean; closed_line: string | null; groups: { label: string; options: { value: string; label: string }[] }[] };
type Option = { value: string; day_label: string; phrase: string; allowed: boolean; ended: boolean; starts_at: Date };

// A zone where the local time is now about `hour` o'clock (Etc/GMT-3 is UTC+3).
function zoneAtHour(hour: number, at = new Date()): string {
  let offset = hour - at.getUTCHours();
  if (offset > 14) offset -= 24;
  if (offset < -12) offset += 24;
  return offset === 0 ? "UTC" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

// a slot's value: the business date (days from today in the zone) and the start hour
const localSlot = async (zone: string, days: number, hour: string) =>
  `${await asAdmin(async (q) => (await q<{ d: string }>("select to_char((now() at time zone $1)::date + $2::int, 'YYYY-MM-DD') as d", [zone, days])).rows[0].d)}-${hour}`;

// SPD-05 follow-ups (owner's answers, 13 October 2026): "now" from 08:00 to 20:00,
// the next working day instead of tomorrow, short Fridays and eves, slots switched
// off per form; and the call task is not announced twice.
describe("call-back slot rules (SPD-05 follow-ups)", () => {
  let owner: U, admin: U, member: U, rep: U;
  let org: string;
  let form: { id: string; token: string };

  beforeAll(async () => {
    owner = await createUser("cbr-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin", "cbr-admin");
    member = await addMember(org, owner.id, "member", "cbr-member");
    rep = await addMember(org, owner.id, "member", "cbr-rep");
    form = await asUser(owner.id, async (q) =>
      (
        await q<{ id: string; token: string }>(
          "insert into public.forms (organization_id, name, title, owner_id, callback_choice) values ($1, 'חלונות', 'פנייה', $2, true) returning id, token",
          [org, rep.id],
        )
      ).rows[0],
    );
  });

  const setCalendar = (weekdays: string, holidays = true, eves = false, occasions = "{}") =>
    asUser(owner.id, (q) =>
      q(
        `insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions)
         values ($1, $2, $3, $4, $5)
         on conflict (organization_id) do update set rest_weekdays = excluded.rest_weekdays, holidays_rest = excluded.holidays_rest,
           holiday_eves_rest = excluded.holiday_eves_rest, rest_occasions = excluded.rest_occasions`,
        [org, weekdays, holidays, eves, occasions],
      ),
    );
  const clearCalendar = () => asAdmin((q) => q("update public.org_calendar_settings set rest_weekdays = '{5,6}', holidays_rest = true, holiday_eves_rest = false, rest_occasions = '{}' where organization_id = $1", [org]));
  const setZone = (zone: string) => asUser(owner.id, (q) => q("update public.organizations set timezone = $2 where id = $1", [org, zone]));

  const offer = (now: string, off: string[] = []) =>
    asAdmin(async (q) => (await q<{ o: Offer }>("select app.intake_callback_offer($1, $2, $3::timestamptz) as o", [org, off, now])).rows[0].o);
  const offered = async (now: string, off: string[] = []) =>
    (await offer(now, off)).groups.map((g) => [g.label, g.options.map((o) => o.value.slice(-2))]);
  const pick = (choice: string, now: string, off: string[] = []) =>
    asAdmin(async (q) => (await q<{ at: Date; phrase: string }>("select * from app.intake_callback_pick($1, $2, $3, $4::timestamptz)", [org, off, choice, now])).rows[0]);
  const options = (now: string) =>
    asAdmin(async (q) => (await q<Option>("select * from app.intake_callback_options($1, '{}', $2::timestamptz)", [org, now])).rows);

  it("offers 'now' only from 08:00 to 20:00 in the business's zone", async () => {
    // Jerusalem in July is UTC+3
    expect((await offer("2026-07-01T04:59:00Z")).now).toBe(false); // 07:59
    expect((await offer("2026-07-01T05:00:00Z")).now).toBe(true); // 08:00
    expect((await offer("2026-07-01T16:59:00Z")).now).toBe(true); // 19:59
    expect((await offer("2026-07-01T17:00:00Z")).now).toBe(false); // 20:00
    expect(await pgError(pick("now", "2026-07-01T17:00:00Z"))).toMatchObject({ code: "22023", hint: "callback:past" });
    expect(await pgError(pick("now", "2026-07-01T04:00:00Z"))).toMatchObject({ code: "22023", hint: "callback:past" });
    const now = await pick("now", "2026-07-01T07:30:00Z");
    expect(now.phrase).toBe("עכשיו");
    expect(now.at.toISOString()).toBe("2026-07-01T07:30:00.000Z");
    // the same instant is 03:30 in New York
    await setZone("America/New_York");
    try {
      expect((await offer("2026-07-01T07:30:00Z")).now).toBe(false);
    } finally {
      await setZone("Asia/Jerusalem");
    }
  });

  it("does not offer a slot of today that has ended, and refuses it as past", async () => {
    // Wednesday 1 July 2026, 10:30: every slot of today, and tomorrow (Thursday) whole
    expect(await offered("2026-07-01T07:30:00Z")).toEqual([
      ["היום", ["09", "12", "15", "18"]],
      ["מחר", ["09", "12", "15", "18"]],
    ]);
    // 12:00: 09-12 has ended
    expect((await offered("2026-07-01T09:00:00Z"))[0]).toEqual(["היום", ["12", "15", "18"]]);
    expect(await pgError(pick("2026-07-01-09", "2026-07-01T09:00:00Z"))).toMatchObject({ hint: "callback:past" });
    // 21:00: only tomorrow
    expect(await offered("2026-07-01T18:00:00Z")).toEqual([["מחר", ["09", "12", "15", "18"]]]);
    // a slot that has started is due now; a later one at its start
    expect((await pick("2026-07-01-12", "2026-07-01T10:00:00Z")).at.toISOString()).toBe("2026-07-01T10:00:00.000Z");
    const later = await pick("2026-07-01-15", "2026-07-01T10:00:00Z");
    expect(later).toMatchObject({ phrase: "היום בין 15:00 ל-18:00" });
    expect(later.at.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    const tomorrow = await pick("2026-07-02-09", "2026-07-01T10:00:00Z");
    expect(tomorrow).toMatchObject({ phrase: "מחר בין 09:00 ל-12:00" });
    expect(tomorrow.at.toISOString()).toBe("2026-07-02T06:00:00.000Z");
  });

  it("a slot keeps its date across midnight: booked on the day shown, or refused, never moved", async () => {
    // Wednesday 23:50: the form shows Thursday as "מחר"
    const before = await offer("2026-07-01T20:50:00Z");
    expect(before.groups.map((g) => [g.label, g.options[0].value])).toEqual([["מחר", "2026-07-02-09"]]);
    // sent at 00:05 on Thursday: still Thursday 09:00, now "today"
    const sent = await pick("2026-07-02-09", "2026-07-01T21:05:00Z");
    expect(sent.phrase).toBe("היום בין 09:00 ל-12:00");
    expect(sent.at.toISOString()).toBe("2026-07-02T06:00:00.000Z");
    // a slot of a day that has passed is refused, not moved to another day
    expect(await pgError(pick("2026-07-01-18", "2026-07-01T21:05:00Z"))).toMatchObject({ code: "22023", hint: "callback:past" });
    // Thursday 23:50 with Friday and Saturday off: Sunday; sent on Friday at 00:05, still Sunday
    expect((await offer("2026-07-02T20:50:00Z")).groups.map((g) => [g.label, g.options[0].value])).toEqual([["יום ראשון", "2026-07-05-09"]]);
    const sunday = await pick("2026-07-05-09", "2026-07-02T21:05:00Z");
    expect(sunday.phrase).toBe("ביום ראשון בין 09:00 ל-12:00");
    expect(sunday.at.toISOString()).toBe("2026-07-05T06:00:00.000Z");
    // a day further on than the next working day was never offered
    expect(await pgError(pick("2026-07-10-09", "2026-07-01T21:05:00Z"))).toMatchObject({ code: "22023", hint: "callback:invalid" });
  });

  it("the second day is the next working day, by name when it is not tomorrow", async () => {
    // Thursday 2 July 2026 with the default rest days (Friday and Saturday): Sunday
    const thursday = "2026-07-02T08:00:00Z";
    expect((await offer(thursday)).groups.map((g) => g.label)).toEqual(["היום", "יום ראשון"]);
    const sunday = await pick("2026-07-05-09", thursday);
    expect(sunday).toMatchObject({ phrase: "ביום ראשון בין 09:00 ל-12:00" });
    expect(sunday.at.toISOString()).toBe("2026-07-05T06:00:00.000Z");
    // a business that rests on Saturday only: Friday is tomorrow, a short day
    await setCalendar("{6}");
    try {
      expect(await offered(thursday)).toEqual([
        ["היום", ["09", "12", "15", "18"]],
        ["מחר", ["09", "12"]],
      ]);
      expect(await pgError(pick("2026-07-03-15", thursday))).toMatchObject({ hint: "callback:invalid" });
      // on the Friday itself: today only until 15:00, then Sunday
      expect(await offered("2026-07-03T05:30:00Z")).toEqual([
        ["היום", ["09", "12"]],
        ["יום ראשון", ["09", "12", "15", "18"]],
      ]);
      expect(await pgError(pick("2026-07-03-18", "2026-07-03T05:30:00Z"))).toMatchObject({ hint: "callback:invalid" });
      // no weekly rest at all: Saturday follows Friday
      await setCalendar("{}");
      expect((await offer("2026-07-03T05:30:00Z")).groups.map((g) => g.label)).toEqual(["היום", "מחר"]);
      await setCalendar("{}", true, false, "{}");
      // a business that works Fridays but not Thursdays: from Wednesday, Friday by name
      await setCalendar("{4,6}");
      expect((await offer("2026-07-01T07:30:00Z")).groups.map((g) => g.label)).toEqual(["היום", "יום שישי"]);
      expect((await pick("2026-07-03-12", "2026-07-01T07:30:00Z")).phrase).toBe("ביום שישי בין 12:00 ל-15:00");
    } finally {
      await clearCalendar();
    }
  });

  it("skips the holidays the business closes on, and shortens the eves", async () => {
    // Saturday 19 September 2026 (a rest day: nothing of today); Sunday 20 is the eve of Yom Kippur
    // (a working day by default), Monday 21 Yom Kippur
    expect(await offered("2026-09-19T07:00:00Z")).toEqual([["מחר", ["09", "12"]]]);
    // on the eve: today until 15:00, then Tuesday (Yom Kippur is a rest day)
    expect(await offered("2026-09-20T05:00:00Z")).toEqual([
      ["היום", ["09", "12"]],
      ["יום שלישי", ["09", "12", "15", "18"]],
    ]);
    // a business that works on holidays: Monday is tomorrow
    await setCalendar("{5,6}", false);
    try {
      expect((await offer("2026-09-20T05:00:00Z")).groups.map((g) => g.label)).toEqual(["היום", "מחר"]);
      // closed on the eves too: from Saturday, the eve is skipped as well as Yom Kippur
      await setCalendar("{6}", true, true);
      expect((await offer("2026-09-19T07:00:00Z")).groups.map((g) => g.label)).toEqual(["יום שלישי"]);
      // one occasion chosen by itself: chol hamoed Sukkot (27 Sep - 1 Oct 2026); Hoshana Raba (2 Oct) is an eve
      await setCalendar("{6}", true, false, "{chol_hamoed_sukkot}");
      expect(await offered("2026-09-25T15:00:00Z")).toEqual([["יום שישי", ["09", "12"]]]);
    } finally {
      await clearCalendar();
    }
  });

  it("leaves out the slots the form switched off, and refuses them", async () => {
    expect(await offered("2026-07-01T04:00:00Z", ["09", "18"])).toEqual([
      ["היום", ["12", "15"]],
      ["מחר", ["12", "15"]],
    ]);
    expect(await pgError(pick("2026-07-02-09", "2026-07-01T04:00:00Z", ["09"]))).toMatchObject({ hint: "callback:invalid" });
    // every slot off: only "now" (in its hours) is left
    expect(await offer("2026-07-01T07:00:00Z", ["09", "12", "15", "18"])).toEqual({ now: true, closed_line: null, groups: [] });
    for (const bad of ["later", "today-10", "nextweek-09", "NOW", "", "today-12", "tomorrow-09", "2026-07-01-10", "2026-02-30-09", "2026-7-1-09"]) {
      expect(await pgError(pick(bad, "2026-07-01T07:00:00Z"))).toMatchObject({ code: "22023", hint: "callback:invalid" });
    }
  });

  it("on the business's rest day: no 'now', nothing of today, only the next working day under the closed line", async () => {
    // Saturday 4 July 2026, 10:00, default rest days (Friday and Saturday)
    const saturday = "2026-07-04T07:00:00Z";
    expect(await offer(saturday)).toEqual({
      now: false,
      closed_line: "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום ראשון?",
      groups: [{ label: "מחר", options: ["09", "12", "15", "18"].map((h) => ({ value: `2026-07-05-${h}`, label: expect.any(String) })) }],
    });
    // refused as not on the list ("בחרו מהרשימה…")
    expect(await pgError(pick("now", saturday))).toMatchObject({ code: "22023", hint: "callback:invalid" });
    expect(await pgError(pick("2026-07-04-12", saturday))).toMatchObject({ code: "22023", hint: "callback:invalid" });
    expect((await pick("2026-07-05-09", saturday)).phrase).toBe("מחר בין 09:00 ל-12:00");
    try {
      // an occasion the business marked as a rest day: Monday 28 September 2026, chol hamoed Sukkot;
      // the next working day is Friday 2 October (Hoshana Raba, an eve: until 15:00)
      await setCalendar("{6}", true, false, "{chol_hamoed_sukkot}");
      const cholHamoed = await offer("2026-09-28T07:00:00Z");
      expect(cholHamoed.now).toBe(false);
      expect(cholHamoed.closed_line).toBe("היום אנחנו סגורים. מתי נוח שנחזור אליך ביום שישי?");
      expect(cholHamoed.groups.map((g) => [g.label, g.options.map((o) => o.value)])).toEqual([["יום שישי", ["2026-10-02-09", "2026-10-02-12"]]]);
      expect(await pgError(pick("now", "2026-09-28T07:00:00Z"))).toMatchObject({ hint: "callback:invalid" });
      // a business with no rest days: Saturday as any day
      await setCalendar("{}", false);
      expect(await offer(saturday)).toMatchObject({ now: true, closed_line: null });
      expect(await offered(saturday)).toEqual([
        ["היום", ["09", "12", "15", "18"]],
        ["מחר", ["09", "12", "15", "18"]],
      ]);
      expect((await pick("now", saturday)).phrase).toBe("עכשיו");
    } finally {
      await clearCalendar();
    }
  });

  it("a short working day (Friday, eve, Yom HaZikaron) before a rest day: slots and 'now' until 15:00, then closed; before a working day, a normal day", async () => {
    try {
      // default rest days: Friday is itself a rest day, closed all day
      expect(await offer("2026-07-03T06:00:00Z")).toMatchObject({ now: false, closed_line: "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום ראשון?" });
      // works on Friday, rests on Saturday: Friday is short
      await setCalendar("{6}");
      // 14:00: "now" and the slots that end by 15:00
      expect(await offer("2026-07-03T11:00:00Z")).toMatchObject({ now: true, closed_line: null });
      expect(await offered("2026-07-03T11:00:00Z")).toEqual([
        ["היום", ["12"]],
        ["יום ראשון", ["09", "12", "15", "18"]],
      ]);
      expect((await pick("now", "2026-07-03T11:59:00Z")).phrase).toBe("עכשיו");
      // 15:00: closed like a rest day, the next working day under the closed line
      const after = await offer("2026-07-03T12:00:00Z");
      expect(after).toMatchObject({ now: false, closed_line: "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום ראשון?" });
      expect(after.groups.map((g) => g.label)).toEqual(["יום ראשון"]);
      // a page from before 15:00 sent after it: the time has passed
      expect(await pgError(pick("now", "2026-07-03T12:05:00Z"))).toMatchObject({ code: "22023", hint: "callback:past" });
      expect(await pgError(pick("2026-07-03-12", "2026-07-03T12:05:00Z"))).toMatchObject({ hint: "callback:past" });
      expect(await pgError(pick("2026-07-03-15", "2026-07-03T12:05:00Z"))).toMatchObject({ hint: "callback:invalid" });
      // no Saturday rest: Friday at 16:00 is a normal day
      await setCalendar("{}", false);
      expect(await offer("2026-07-03T13:00:00Z")).toMatchObject({ now: true, closed_line: null });
      expect((await offered("2026-07-03T13:00:00Z"))[0]).toEqual(["היום", ["15", "18"]]);
      // and a Friday that is the next working day is whole too (from Thursday)
      expect((await offered("2026-07-02T07:00:00Z"))[1]).toEqual(["מחר", ["09", "12", "15", "18"]]);
      // the eve of Yom Kippur (Sunday 20 September 2026) at 16:00: closed when Yom Kippur is a rest day…
      await setCalendar("{6}");
      expect(await offer("2026-09-20T13:00:00Z")).toMatchObject({ now: false, closed_line: "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום שלישי?" });
      // …a normal day when the business works on holidays
      await setCalendar("{6}", false);
      expect(await offer("2026-09-20T13:00:00Z")).toMatchObject({ now: true, closed_line: null });
      expect((await offered("2026-09-20T13:00:00Z"))[0]).toEqual(["היום", ["15", "18"]]);
      // Yom HaZikaron (Tuesday 21 April 2026) is a short working day by the same rule:
      // Yom HaAtzmaut a rest day → until 15:00, then Thursday
      await setCalendar("{6}");
      expect(await offer("2026-04-21T11:00:00Z")).toMatchObject({ now: true, closed_line: null });
      expect((await offered("2026-04-21T11:00:00Z"))[0]).toEqual(["היום", ["12"]]);
      expect(await offer("2026-04-21T13:00:00Z")).toMatchObject({ now: false, closed_line: "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום חמישי?" });
      expect(await pgError(pick("now", "2026-04-21T13:00:00Z"))).toMatchObject({ hint: "callback:past" });
      // as the next working day (from Monday) it is short too
      expect((await offered("2026-04-20T07:00:00Z"))[1]).toEqual(["מחר", ["09", "12"]]);
      // Yom HaAtzmaut a working day: a normal day
      await setCalendar("{6}", false);
      expect(await offer("2026-04-21T13:00:00Z")).toMatchObject({ now: true, closed_line: null });
      expect((await offered("2026-04-21T13:00:00Z"))[0]).toEqual(["היום", ["15", "18"]]);
    } finally {
      await clearCalendar();
    }
  });

  it("on a rest day intake_submit refuses 'now' and today's slots; the next working day still makes a lead", async () => {
    const zone = zoneAtHour(12);
    // today (in that zone) is the business's only weekly rest day
    const dow = await asAdmin(async (q) => (await q<{ d: number }>("select extract(dow from (now() at time zone $1))::int as d", [zone])).rows[0].d);
    await setZone(zone);
    await setCalendar(`{${dow}}`, false);
    try {
      const submit = (choice: string, phone: string) =>
        asService(async (q) =>
          (await q<{ r: { status: string; lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [form.token, JSON.stringify({ full_name: "יום מנוחה", phone, callback: choice })])).rows[0].r,
        );
      expect(await pgError(submit("now", "050-7300101"))).toMatchObject({ code: "22023", hint: "callback:invalid" });
      expect(await pgError(submit(await localSlot(zone, 0, "15"), "050-7300102"))).toMatchObject({ code: "22023", hint: "callback:invalid" });
      const r = await submit(await localSlot(zone, 1, "09"), "050-7300103");
      expect(r.status).toBe("accepted");
      // the lead's owner is told at once, as on any day
      expect(await asAdmin((q) => count(q, "select 1 from public.notifications where entity_type = 'lead' and entity_id = $1 and user_id = $2", [r.lead_id, rep.id]))).toBe(1);
    } finally {
      await setZone("Asia/Jerusalem");
      await clearCalendar();
    }
  });

  it("lists every candidate with what is allowed and what has ended", async () => {
    const rows = await options("2026-07-03T09:30:00Z"); // Friday 12:30, default rest days: closed today
    expect(rows.map((r) => [r.value, r.day_label, r.allowed, r.ended])).toEqual([
      ["2026-07-03-09", "היום", false, true],
      ["2026-07-03-12", "היום", false, false],
      ["2026-07-03-15", "היום", false, false],
      ["2026-07-03-18", "היום", false, false],
      ["2026-07-05-09", "יום ראשון", true, false],
      ["2026-07-05-12", "יום ראשון", true, false],
      ["2026-07-05-15", "יום ראשון", true, false],
      ["2026-07-05-18", "יום ראשון", true, false],
    ]);
  });

  it("the Hebrew calendar matches the app's (holidays.ts), day by day", async () => {
    const from = "2024-01-01";
    const to = "2046-12-31";
    const db = await asAdmin(async (q) =>
      (
        await q<{ day: string; h_year: number; h_month: number; h_day: number; occasions: string | null }>(
          `select to_char(d, 'YYYY-MM-DD') as day, h.h_year, h.h_month, h.h_day,
                  (select string_agg(o.key || ':' || o.kind, ',') from app.israel_occasions(d::date) o) as occasions
             from generate_series($1::date, $2::date, interval '1 day') d,
                  lateral app.hebrew_date(d::date) h
            order by d`,
          [from, to],
        )
      ).rows,
    );
    let day = from;
    const mismatches: string[] = [];
    for (const row of db) {
      expect(row.day).toBe(day);
      const hd = hebrewDate(day)!;
      const occasions = holidaysOn(day).map((h) => `${h.key}:${h.kind}`).join(",") || null;
      if (hd.year !== row.h_year || hd.month !== row.h_month || hd.day !== row.h_day || occasions !== row.occasions) {
        mismatches.push(`${day}: app ${hd.year}/${hd.month}/${hd.day} ${occasions} db ${row.h_year}/${row.h_month}/${row.h_day} ${row.occasions}`);
      }
      day = addDays(day, 1);
    }
    expect(db.length).toBeGreaterThan(8000);
    expect(mismatches).toEqual([]);
  });

  it("the rest days match the app's (isRestDay), for several settings", async () => {
    const variants: [string, CalendarSettings][] = [
      ["{5,6}", DEFAULT_CALENDAR_SETTINGS],
      ["{6}", { restWeekdays: [6], holidaysRest: false, holidayEvesRest: true, restOccasions: ["chol_hamoed_pesach", "purim"] }],
      ["{}", { restWeekdays: [], holidaysRest: true, holidayEvesRest: false, restOccasions: ["yom_hazikaron", "mimouna"] }],
    ];
    try {
      for (const [weekdays, settings] of variants) {
        await setCalendar(weekdays, settings.holidaysRest, settings.holidayEvesRest, `{${settings.restOccasions.join(",")}}`);
        const db = await asAdmin(async (q) =>
          (
            await q<{ day: string; rest: boolean }>(
              `select to_char(d, 'YYYY-MM-DD') as day, app.org_rest_day($1, d::date) as rest
                 from generate_series('2026-01-01'::date, '2027-12-31'::date, interval '1 day') d order by d`,
              [org],
            )
          ).rows,
        );
        const wrong = db.filter((r) => r.rest !== isRestDay(r.day, settings)).map((r) => r.day);
        expect(wrong).toEqual([]);
      }
    } finally {
      await clearCalendar();
    }
  });

  it("only owners and admins switch slots off; only the four start hours are stored", async () => {
    const setOff = (user: U, value: string) =>
      asUser(user.id, async (q) => (await q("update public.forms set callback_slots_off = $2 where id = $1", [form.id, value])).rowCount ?? 0);
    expect(await setOff(member, "{09}")).toBe(0);
    expect(await setOff(admin, "{09}")).toBe(1);
    expect(await setOff(owner, "{09,18}")).toBe(1);
    for (const bad of ["{10}", "{9}", "{NULL}", "{now}"]) {
      expect((await pgError(setOff(owner, bad))).code).toBe("23514");
    }
    const grants = await asAdmin(async (q) =>
      (
        await q<{ privilege_type: string }>(
          `select privilege_type from information_schema.column_privileges
            where table_schema = 'public' and table_name = 'forms' and grantee = 'authenticated'
              and column_name = 'callback_slots_off' order by privilege_type collate "C"`,
        )
      ).rows.map((r) => r.privilege_type),
    );
    expect(grants).toEqual(["INSERT", "SELECT", "UPDATE"]);
    // the hosted form and intake_submit follow the switch
    const zone = zoneAtHour(5); // 05:xx: every slot of today is still ahead, "now" is not offered
    await setZone(zone);
    await setCalendar("{}", false);
    try {
      const callback = await asService(async (q) =>
        (await q<{ r: { callback: Offer & { time_zone: string } } }>("select public.intake_form($1) as r", [form.token])).rows[0].r.callback,
      );
      expect(callback).toMatchObject({ time_zone: zone, now: false });
      // 05:xx: nothing of today has ended; 09 and 18 are switched off (15 may be cut by a short day)
      const values = callback.groups.flatMap((g) => g.options.map((o) => o.value));
      expect(values).toContain(await localSlot(zone, 0, "12"));
      expect(values).toContain(await localSlot(zone, 1, "12"));
      expect(values.filter((v) => v.endsWith("-09") || v.endsWith("-18"))).toEqual([]);
      const submit = (choice: string) =>
        asService(async (q) =>
          (await q<{ r: { status: string } }>("select public.intake_submit($1, 'form', $2) as r", [form.token, JSON.stringify({ full_name: "חלון כבוי", phone: "050-7300001", callback: choice })])).rows[0].r,
        );
      expect(await pgError(submit(await localSlot(zone, 0, "09")))).toMatchObject({ code: "22023", hint: "callback:invalid" });
      expect(await pgError(submit("now"))).toMatchObject({ code: "22023", hint: "callback:past" });
      expect((await submit(await localSlot(zone, 0, "12"))).status).toBe("accepted");
    } finally {
      await setZone("Asia/Jerusalem");
      await clearCalendar();
      await setOff(owner, "{}");
    }
  });
});

describe("the call task is not announced twice (SPD-05 follow-ups)", () => {
  let owner: U, rep: U, other: U;
  let org: string;
  let token: string;
  const noon = zoneAtHour(12);

  beforeAll(async () => {
    owner = await createUser("cbn-owner");
    org = await createOrg(owner.id, "עסק ההתראות");
    rep = await addMember(org, owner.id, "member", "cbn-rep");
    other = await addMember(org, owner.id, "member", "cbn-other");
    await asUser(owner.id, async (q) => {
      // noon, every day a working day
      await q("update public.organizations set timezone = $2 where id = $1", [org, noon]);
      await q("insert into public.org_calendar_settings (organization_id, rest_weekdays, holidays_rest) values ($1, '{}', false)", [org]);
    });
    token = await asUser(owner.id, async (q) =>
      (
        await q<{ token: string }>(
          "insert into public.forms (organization_id, name, title, owner_id, callback_choice) values ($1, 'התראות', 'פנייה', $2, true) returning token",
          [org, rep.id],
        )
      ).rows[0].token,
    );
  });

  const submit = (payload: Record<string, unknown>) =>
    asService(async (q) => (await q<{ r: { status: string; lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify(payload)])).rows[0].r);
  const taskOf = (lead: string) =>
    asAdmin(async (q) => (await q<{ id: string; owner_id: string; remind_at: Date | null; due_at: Date }>("select id, owner_id, remind_at, due_at from public.tasks where lead_id = $1", [lead])).rows[0]);
  const notes = (user: U, ids: string[]) =>
    asAdmin(async (q) =>
      (
        await q<{ type: string; entity_type: string }>(
          "select type, entity_type from public.notifications where user_id = $1 and entity_id = any ($2) order by entity_type collate \"C\", type collate \"C\"",
          [user.id, ids],
        )
      ).rows.map((r) => `${r.entity_type}:${r.type}`),
    );

  it("'now': the lead's owner is told once, about the lead; the task is in their list with no reminder", async () => {
    const r = await submit({ full_name: "עכשיו", phone: "050-7310001", callback: "now" });
    const task = await taskOf(r.lead_id);
    expect(task).toMatchObject({ owner_id: rep.id, remind_at: null });
    expect(await notes(rep, [r.lead_id, task.id])).toHaveLength(1);
    expect((await notes(rep, [r.lead_id, task.id]))[0]).toMatch(/^lead:/);
    // what the task list reads (RLS as the rep)
    expect(await asUser(rep.id, (q) => count(q, "select 1 from public.tasks where id = $1 and status = 'open'", [task.id]))).toBe(1);
  });

  it("a later slot: no task notification now, the normal reminder at the slot's start", async () => {
    const r = await submit({ full_name: "מחר", phone: "050-7310002", callback: await localSlot(noon, 1, "09") });
    const task = await taskOf(r.lead_id);
    expect(task.remind_at?.getTime()).toBe(task.due_at.getTime());
    expect(await notes(rep, [task.id])).toEqual([]);
    // when the slot comes, the reminder job tells the owner (moved to now here)
    await asAdmin(async (q) => {
      await q("update public.tasks set remind_at = now() - interval '1 minute' where id = $1", [task.id]);
      await q("select app.send_task_reminders()");
    });
    expect(await notes(rep, [task.id])).toEqual(["task:task_reminder"]);
  });

  it("a task for someone other than the person told about the lead is announced as before", async () => {
    // the lead goes to the rep; the task of a repeat inquiry onto another member's lead goes to that member
    const lead = await insertLead(other.id, org, { full_name: "קיים", phone: "050-7310003" });
    await asAdmin((q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, other.id]));
    try {
      await submit({ full_name: "קיים", phone: "050-7310003", callback: "now" });
      const task = await taskOf(lead);
      // the record's owner is suspended: the form's owner (rep) gets the task, and was not told about the lead
      expect(task.owner_id).toBe(rep.id);
      expect(await notes(rep, [lead, task.id])).toEqual(["task:assigned"]);
    } finally {
      await asAdmin((q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, other.id]));
    }
  });

  it("other tasks, even in the same transaction, are announced as before", async () => {
    const ids = await asService(async (q) => {
      const r = (await q<{ r: { lead_id: string } }>("select public.intake_submit($1, 'form', $2) as r", [token, JSON.stringify({ full_name: "עוד", phone: "050-7310004", callback: "now" })])).rows[0].r;
      const t = (
        await q<{ id: string }>("insert into public.tasks (organization_id, title, owner_id, lead_id) values ($1, 'משימה רגילה', $2, $3) returning id", [org, rep.id, r.lead_id])
      ).rows[0].id;
      return { lead: r.lead_id, task: t };
    });
    expect(await notes(rep, [ids.task])).toEqual(["task:assigned"]);
    expect(await notes(rep, [ids.lead])).toHaveLength(1);
  });
});

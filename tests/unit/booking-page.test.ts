import { describe, expect, it } from "vitest";

import { addDays, bookingIcs, bookingManageFrom, confirmationFrom, fromParam, localDate, publicBookingFrom, slotsByDay } from "@/features/booking/public";
import { CANCEL_NOTICE_MAX, CANCEL_NOTICE_OPTIONS, bookingPageSchema as pageSchema } from "@/features/booking/schema";
import { bookingPageSchema, questionsFromForm, readQuestions } from "@/features/booking/schema";

// CAL-10: the public booking page's pure parts: reading the database's answers, days and slots, the settings form.

const reply = {
  title: "קביעת פגישה",
  intro: null,
  business: "העסק",
  rep: "דנה",
  brand: { logo: null, color: "#123456" },
  built_with: true,
  time_zone: "Asia/Jerusalem",
  meeting: { name: "ייעוץ", duration_minutes: 45, format: "video", location: null },
  questions: [{ id: "goal", label: "מה המטרה?", required: true }, { bad: true }],
  today: "2026-10-15",
  last_day: "2026-10-18",
  from: "2026-10-15",
  // 09:00 and 10:00 in Israel on the 15th (UTC+3), one on the 17th, and one that is not a time
  slots: ["2026-10-15T06:00:00Z", "2026-10-15T07:00:00Z", "2026-10-17T21:30:00Z", "x"],
};

describe("public booking page data (CAL-10)", () => {
  it("reads the page, dropping what is not well formed", () => {
    const page = publicBookingFrom(reply);
    expect(page).toMatchObject({
      title: "קביעת פגישה",
      rep: "דנה",
      brand: { logoPath: null, color: "#123456" },
      builtWith: true,
      meeting: { name: "ייעוץ", durationMinutes: 45, format: "video", location: null },
      questions: [{ id: "goal", label: "מה המטרה?", required: true }],
    });
    expect(page?.slots).toHaveLength(3);
    expect(publicBookingFrom({ unavailable: true })).toBeNull();
    expect(publicBookingFrom({ ...reply, today: "15/10/2026" })).toBeNull();
    expect(publicBookingFrom(null)).toBeNull();
  });

  it("groups the slots by local day, up to the last day", () => {
    const page = publicBookingFrom(reply)!;
    const days = slotsByDay(page);
    // the 15th to the 18th (the last day), 4 days; 21:30 UTC on the 17th is the 18th in Israel
    expect(days.map((d) => d.day)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"]);
    expect(days[0].slots).toHaveLength(2);
    expect(days[2].slots).toEqual([]);
    expect(days[3].slots).toEqual(["2026-10-17T21:30:00Z"]);
    expect(localDate("2026-10-17T21:30:00Z", "Asia/Jerusalem")).toBe("2026-10-18");
  });

  it("dates and the week parameter", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-29", -7)).toBe("2026-03-22");
    expect(fromParam("2026-10-20")).toBe("2026-10-20");
    expect(fromParam("2026-10-20T00:00")).toBeNull();
    expect(fromParam(["2026-10-20"])).toBeNull();
    expect(fromParam(undefined)).toBeNull();
  });

  it("reads a confirmation only of a booking that was made", () => {
    expect(
      confirmationFrom({
        status: "booked",
        starts_at: "2026-10-20T07:00:00+00:00",
        ends_at: "2026-10-20T07:45:00+00:00",
        time_zone: "Asia/Jerusalem",
        meeting: { name: "ייעוץ", format: "video", location: null },
        rep: "דנה",
      }),
    ).toMatchObject({ startsAt: "2026-10-20T07:00:00+00:00", rep: "דנה", meeting: { name: "ייעוץ" }, manageToken: null });
    // CAL-10b: the personal link's token, only in its own shape
    const token = "a".repeat(64);
    const booked = { status: "booked", starts_at: "2026-10-20T07:00:00+00:00", ends_at: "2026-10-20T07:45:00+00:00", time_zone: "UTC", meeting: { name: "x" } };
    expect(confirmationFrom({ ...booked, manage_token: token })?.manageToken).toBe(token);
    expect(confirmationFrom({ ...booked, manage_token: "../x" })?.manageToken).toBeNull();
    expect(confirmationFrom({ status: "spam" })).toBeNull();
    expect(confirmationFrom(null)).toBeNull();
  });
});

describe("booking page settings form (CAL-10)", () => {
  const form = (entries: Record<string, string>) => {
    const data = new FormData();
    for (const [k, v] of Object.entries(entries)) data.set(k, v);
    return data;
  };

  it("questions: empty rows skipped, ids kept or made, too long refused", () => {
    let n = 0;
    const made = () => `new${++n}`;
    const result = questionsFromForm(
      form({ question_0: "מה המטרה?", question_required_0: "on", question_id_0: "goal", question_1: "  ", question_2: "הערות", question_id_2: "BAD ID" }),
      made,
    );
    expect(result).toEqual({
      ok: true,
      questions: [
        { id: "goal", label: "מה המטרה?", required: true },
        { id: "new1", label: "הערות", required: false },
      ],
    });
    expect(questionsFromForm(form({ question_0: "א".repeat(201) }), made).ok).toBe(false);
    // the same id twice gets a new one for the second
    const twice = questionsFromForm(form({ question_0: "א", question_id_0: "x", question_1: "ב", question_id_1: "x" }), made);
    expect(twice.ok && twice.questions.map((q) => q.id)).toEqual(["x", "new2"]);
    expect(readQuestions("nope")).toEqual([]);
  });

  it("the page's settings: required type and title, closed lists, days ahead 1..365", () => {
    const base = { title: "דף", meeting_type_id: "11111111-1111-4111-8111-111111111111", max_days_ahead: "30" };
    const ok = bookingPageSchema.safeParse(base);
    expect(ok.success && ok.data).toMatchObject({ min_notice_minutes: 120, slot_step_minutes: 30, max_days_ahead: 30, is_active: false, user_id: null });
    expect(bookingPageSchema.safeParse({ ...base, meeting_type_id: "" }).success).toBe(false);
    expect(bookingPageSchema.safeParse({ ...base, title: " " }).success).toBe(false);
    expect(bookingPageSchema.safeParse({ ...base, max_days_ahead: "0" }).success).toBe(false);
    expect(bookingPageSchema.safeParse({ ...base, max_days_ahead: "366" }).success).toBe(false);
    expect(bookingPageSchema.safeParse({ ...base, slot_step_minutes: "45" }).success).toBe(false);
    expect(bookingPageSchema.safeParse({ ...base, min_notice_minutes: "1440", slot_step_minutes: "15" }).success).toBe(true);
  });
});

describe("the settings form and the database agree (CAL-10)", () => {
  it("steps, limits and lengths are the migration's", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const sql = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_booking_page.sql"))!), "utf8");
    const schema = await import("@/features/booking/schema");
    expect(sql).toContain(`slot_step_minutes in (${schema.SLOT_STEP_OPTIONS.map((o) => o.value).join(", ")})`);
    expect(sql).toContain(`char_length(title) between 1 and ${schema.BOOKING_TITLE_MAX}`);
    expect(sql).toContain(`char_length(intro) between 1 and ${schema.BOOKING_INTRO_MAX}`);
    expect(sql).toContain(`jsonb_array_length(questions) <= ${schema.BOOKING_QUESTIONS_MAX}`);
    expect(sql).toContain(`not between 1 and ${schema.BOOKING_QUESTION_MAX}`);
    expect(sql).toContain(`max_days_ahead between ${schema.MAX_DAYS_AHEAD_MIN} and ${schema.MAX_DAYS_AHEAD_MAX}`);
    expect(sql).toContain(`left(btrim(v_answers_in ->> (v_question ->> 'id')), ${schema.BOOKING_ANSWER_MAX})`);
    for (const o of schema.MIN_NOTICE_OPTIONS) expect(Number(o.value)).toBeLessThanOrEqual(10080);
  });
});

describe("the calendar file of a booking (CAL-10)", () => {
  const confirmation = {
    startsAt: "2026-10-20T07:00:00.000Z",
    endsAt: "2026-10-20T08:00:00.000Z",
    timeZone: "Asia/Jerusalem",
    meeting: { name: "ייעוץ ראשון", format: "in_person", location: "רחוב הרצל 1, תל אביב" },
    rep: "דנה",
    manageToken: null,
  };

  it("holds only the confirmation and the business name", () => {
    const ics = bookingIcs(confirmation, "עסק התורים", "abc", new Date("2026-10-15T10:00:00Z"));
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("UID:meeting-booking-abc@");
    expect(unfolded).toContain("DTSTART:20261020T070000Z");
    expect(unfolded).toContain("DTEND:20261020T080000Z");
    expect(unfolded).toContain("SUMMARY:ייעוץ ראשון עם דנה · עסק התורים");
    expect(unfolded).toContain("LOCATION:רחוב הרצל 1\\, תל אביב");
    expect(unfolded).toContain("X-WR-TIMEZONE:Asia/Jerusalem");
    expect(unfolded).toContain("STATUS:CONFIRMED");
    expect(unfolded).not.toContain("ORGANIZER");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("works without a rep name or a location", () => {
    const unfolded = bookingIcs({ ...confirmation, rep: "", meeting: { ...confirmation.meeting, location: null } }, "עסק", "x").replace(/\r\n /g, "");
    expect(unfolded).toContain("SUMMARY:ייעוץ ראשון · עסק");
    expect(unfolded).not.toContain("LOCATION:");
  });
});

describe("the personal page of a booking (CAL-10b)", () => {
  const reply = {
    status: "planned",
    starts_at: "2026-10-20T07:00:00+00:00",
    ends_at: "2026-10-20T08:00:00+00:00",
    time_zone: "Asia/Jerusalem",
    meeting: { name: "ייעוץ", format: "phone", location: null },
    rep: "דנה",
    business: "העסק",
    brand: { logo: null, color: "#123456" },
    built_with: false,
    notice_hours: 24,
    can_cancel: true,
    call_phone: null,
    change: { today: "2026-10-16", last_day: "2026-11-15", from: "2026-10-16", slots: ["2026-10-21T07:00:00+00:00", "nope"] },
  };

  it("reads the reply, and drops what is not in shape", () => {
    expect(bookingManageFrom(reply)).toMatchObject({ status: "planned", canCancel: true, noticeHours: 24, callPhone: null, change: { from: "2026-10-16", slots: ["2026-10-21T07:00:00+00:00"] } });
    expect(bookingManageFrom({ ...reply, change: null, can_cancel: false, call_phone: "03-1234567" })).toMatchObject({ change: null, canCancel: false, callPhone: "03-1234567" });
    expect(bookingManageFrom({ ...reply, status: "deleted" })).toBeNull();
    expect(bookingManageFrom({ ...reply, starts_at: "x" })).toBeNull();
    expect(bookingManageFrom({ unavailable: true })).toBeNull();
  });

  it("the threshold's choices are the database's range, 24 by default", async () => {
    const values = CANCEL_NOTICE_OPTIONS.map((o) => Number(o.value));
    expect(Math.min(...values)).toBe(0);
    expect(Math.max(...values)).toBe(CANCEL_NOTICE_MAX);
    const { readdirSync, readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const sql = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_booking_manage.sql"))!), "utf8");
    expect(sql).toContain(`check (cancel_notice_hours between 0 and ${CANCEL_NOTICE_MAX})`);
    expect(sql).toContain("cancel_notice_hours smallint not null default 24");
    const base = { title: "דף", meeting_type_id: "00000000-0000-4000-8000-000000000001", max_days_ahead: "30" };
    expect(pageSchema.parse({ ...base }).cancel_notice_hours).toBe(24);
    expect(pageSchema.parse({ ...base, cancel_notice_hours: "0" }).cancel_notice_hours).toBe(0);
    expect(pageSchema.safeParse({ ...base, cancel_notice_hours: "73" }).success).toBe(false);
  });
});

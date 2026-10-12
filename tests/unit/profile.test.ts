import { describe, expect, it } from "vitest";

import { avatarFileProblem, isOwnAvatarPath } from "@/features/profile/avatar";
import { isTimeZone, isWorkingHours, MAX_DAY_RANGES, nextRange, parseWorkingHours, readWorkingHours } from "@/features/profile/working-hours";

import { WORKING_HOURS_CASES } from "../working-hours-cases";

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
};

describe("working hours (USR-01)", () => {
  it("reads the ticked days from the form, one range each", () => {
    const result = parseWorkingHours(
      form({
        day_sun: "on",
        start_sun_0: "08:00",
        end_sun_0: "16:30",
        start_mon_0: "09:00",
        end_mon_0: "17:00",
        day_fri: "on",
        start_fri_0: "09:00",
        end_fri_0: "13:00",
      }),
    );
    expect(result).toEqual({ ok: true, hours: { sun: [{ start: "08:00", end: "16:30" }], fri: [{ start: "09:00", end: "13:00" }] } });
  });

  it("reads a split day and sorts its ranges", () => {
    const result = parseWorkingHours(
      form({ day_sun: "on", start_sun_0: "16:00", end_sun_0: "19:00", start_sun_1: "08:00", end_sun_1: "12:00" }),
    );
    expect(result).toEqual({ ok: true, hours: { sun: [{ start: "08:00", end: "12:00" }, { start: "16:00", end: "19:00" }] } });
    // ranges that touch are fine; a gap in the indexes (a removed range) too
    expect(
      parseWorkingHours(form({ day_mon: "on", start_mon_0: "08:00", end_mon_0: "12:00", start_mon_2: "12:00", end_mon_2: "14:00" })),
    ).toEqual({ ok: true, hours: { mon: [{ start: "08:00", end: "12:00" }, { start: "12:00", end: "14:00" }] } });
  });

  it("still reads a form of the first version", () => {
    expect(parseWorkingHours(form({ day_sun: "on", start_sun: "08:00", end_sun: "16:30" }))).toEqual({
      ok: true,
      hours: { sun: [{ start: "08:00", end: "16:30" }] },
    });
  });

  it("no ticked day is an empty week", () => {
    expect(parseWorkingHours(form({ start_sun_0: "08:00" }))).toEqual({ ok: true, hours: {} });
  });

  it("rejects a missing or malformed time, and an end before the start", () => {
    expect(parseWorkingHours(form({ day_mon: "on", start_mon_0: "", end_mon_0: "17:00" }))).toMatchObject({ ok: false, day: "mon" });
    expect(parseWorkingHours(form({ day_mon: "on" }))).toMatchObject({ ok: false, day: "mon" });
    expect(parseWorkingHours(form({ day_mon: "on", start_mon_0: "9:00", end_mon_0: "17:00" }))).toMatchObject({ ok: false, day: "mon" });
    expect(parseWorkingHours(form({ day_tue: "on", start_tue_0: "17:00", end_tue_0: "09:00" }))).toMatchObject({ ok: false, day: "tue" });
    expect(parseWorkingHours(form({ day_tue: "on", start_tue_0: "10:00", end_tue_0: "10:00" }))).toMatchObject({ ok: false, day: "tue" });
    const failed = parseWorkingHours(form({ day_wed: "on", start_wed_0: "12:00", end_wed_0: "11:00" }));
    expect(failed.ok ? "" : failed.message).toContain("רביעי");
    expect(failed.ok ? "" : failed.message).toContain("אחרי שעת ההתחלה");
    // in a split day the message says which range
    const second = parseWorkingHours(form({ day_wed: "on", start_wed_0: "08:00", end_wed_0: "11:00", start_wed_1: "19:00", end_wed_1: "16:00" }));
    expect(second.ok ? "" : second.message).toContain("בטווח 2");
  });

  it("rejects overlapping ranges and more than three", () => {
    const overlap = parseWorkingHours(
      form({ day_thu: "on", start_thu_0: "08:00", end_thu_0: "12:00", start_thu_1: "11:00", end_thu_1: "14:00" }),
    );
    expect(overlap).toMatchObject({ ok: false, day: "thu" });
    expect(overlap.ok ? "" : overlap.message).toContain("חופפים");
    const inside = parseWorkingHours(form({ day_thu: "on", start_thu_0: "10:00", end_thu_0: "11:00", start_thu_1: "08:00", end_thu_1: "18:00" }));
    expect(inside).toMatchObject({ ok: false, day: "thu" });
    const fields: Record<string, string> = { day_sat: "on" };
    for (const [i, h] of ["06", "08", "10", "12"].entries()) {
      fields[`start_sat_${i}`] = `${h}:00`;
      fields[`end_sat_${i}`] = `${h}:30`;
    }
    const four = parseWorkingHours(form(fields));
    expect(four).toMatchObject({ ok: false, day: "sat" });
    expect(four.ok ? "" : four.message).toContain(`עד ${MAX_DAY_RANGES}`);
    delete fields.start_sat_3;
    delete fields.end_sat_3;
    expect(parseWorkingHours(form(fields))).toMatchObject({ ok: true });
  });

  it("whatever the form accepts, the stored shape accepts", () => {
    const result = parseWorkingHours(
      form({ day_sun: "on", start_sun_0: "16:00", end_sun_0: "19:00", start_sun_1: "08:00", end_sun_1: "12:00", start_sun_2: "13:00", end_sun_2: "15:00" }),
    );
    expect(result.ok && isWorkingHours(result.hours)).toBe(true);
  });

  it.each(WORKING_HOURS_CASES)("stored shape: $name", ({ value, ok }) => {
    expect(isWorkingHours(value)).toBe(ok);
  });

  it("reads the first version as a list of one range; a malformed value as not set", () => {
    expect(readWorkingHours({ sun: "09-17" })).toBeNull();
    expect(readWorkingHours(undefined)).toBeNull();
    expect(readWorkingHours(null)).toBeNull();
    expect(readWorkingHours({ sun: [{ start: "12:00", end: "13:00" }, { start: "11:00", end: "14:00" }] })).toBeNull();
    expect(readWorkingHours({ mon: { start: "09:00", end: "17:00" } })).toEqual({ mon: [{ start: "09:00", end: "17:00" }] });
    expect(
      readWorkingHours({ mon: { start: "09:00", end: "17:00" }, tue: [{ start: "08:00", end: "12:00" }, { start: "16:00", end: "19:00" }] }),
    ).toEqual({ mon: [{ start: "09:00", end: "17:00" }], tue: [{ start: "08:00", end: "12:00" }, { start: "16:00", end: "19:00" }] });
    // every valid stored case reads back in the list shape, and that is valid too
    for (const { value, ok } of WORKING_HOURS_CASES) {
      if (!ok || value === null) continue;
      const read = readWorkingHours(value);
      expect(read).not.toBeNull();
      expect(Object.values(read ?? {}).every(Array.isArray)).toBe(true);
      expect(isWorkingHours(read)).toBe(true);
    }
  });

  it("offers a next range after the last one, within the day", () => {
    expect(nextRange([{ start: "08:00", end: "12:00" }])).toEqual({ start: "13:00", end: "15:00" });
    expect(nextRange([{ start: "08:00", end: "22:30" }])).toEqual({ start: "23:00", end: "23:59" });
    expect(nextRange([{ start: "08:00", end: "23:30" }])).toEqual({ start: "", end: "" });
    expect(nextRange([])).toEqual({ start: "16:00", end: "19:00" });
  });
});

describe("time zone (USR-01)", () => {
  it("accepts IANA names the runtime knows, and UTC", () => {
    expect(isTimeZone("Asia/Jerusalem")).toBe(true);
    expect(isTimeZone("America/Argentina/Salta")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
  });

  it("rejects anything else", () => {
    for (const value of ["", "Asia/Atlantis", "asia/jerusalem", "IST", "+02:00", "Asia/Jerusalem ", null, 3]) {
      expect(isTimeZone(value)).toBe(false);
    }
  });
});

describe("profile photo (USR-01)", () => {
  const user = "0b6c1b0e-6f5a-4c51-9a7e-2f1d3c4b5a69";
  it("a photo path is '<own user id>/<uuid>'", () => {
    expect(isOwnAvatarPath(`${user}/6a1f0f2e-2d3c-4b5a-8c7d-9e0f1a2b3c4d`, user)).toBe(true);
    expect(isOwnAvatarPath(`6a1f0f2e-2d3c-4b5a-8c7d-9e0f1a2b3c4d/${user}`, user)).toBe(false);
    expect(isOwnAvatarPath(`${user}/photo.png`, user)).toBe(false);
    expect(isOwnAvatarPath(`${user}/../x`, user)).toBe(false);
    expect(isOwnAvatarPath(null, user)).toBe(false);
  });

  it("only small JPG, PNG or WebP images", () => {
    expect(avatarFileProblem({ type: "image/png", size: 1000 })).toBeNull();
    expect(avatarFileProblem({ type: "image/svg+xml", size: 1000 })).not.toBeNull();
    expect(avatarFileProblem({ type: "image/jpeg", size: 2 * 1024 * 1024 + 1 })).not.toBeNull();
    expect(avatarFileProblem({ type: "image/webp", size: 0 })).not.toBeNull();
  });
});

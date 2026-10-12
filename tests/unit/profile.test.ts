import { describe, expect, it } from "vitest";

import { avatarFileProblem, isOwnAvatarPath } from "@/features/profile/avatar";
import { isTimeZone, isWorkingHours, parseWorkingHours, readWorkingHours } from "@/features/profile/working-hours";

const form = (entries: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.append(key, value);
  return data;
};

describe("working hours (USR-01)", () => {
  it("reads the ticked days from the form", () => {
    const result = parseWorkingHours(
      form({ day_sun: "on", start_sun: "08:00", end_sun: "16:30", start_mon: "09:00", end_mon: "17:00", day_fri: "on", start_fri: "09:00", end_fri: "13:00" }),
    );
    expect(result).toEqual({ ok: true, hours: { sun: { start: "08:00", end: "16:30" }, fri: { start: "09:00", end: "13:00" } } });
  });

  it("no ticked day is an empty week", () => {
    expect(parseWorkingHours(form({ start_sun: "08:00" }))).toEqual({ ok: true, hours: {} });
  });

  it("rejects a missing or malformed time, and an end before the start", () => {
    expect(parseWorkingHours(form({ day_mon: "on", start_mon: "", end_mon: "17:00" }))).toMatchObject({ ok: false, day: "mon" });
    expect(parseWorkingHours(form({ day_mon: "on", start_mon: "9:00", end_mon: "17:00" }))).toMatchObject({ ok: false, day: "mon" });
    expect(parseWorkingHours(form({ day_tue: "on", start_tue: "17:00", end_tue: "09:00" }))).toMatchObject({ ok: false, day: "tue" });
    expect(parseWorkingHours(form({ day_tue: "on", start_tue: "10:00", end_tue: "10:00" }))).toMatchObject({ ok: false, day: "tue" });
    const failed = parseWorkingHours(form({ day_wed: "on", start_wed: "12:00", end_wed: "11:00" }));
    expect(failed.ok ? "" : failed.message).toContain("רביעי");
  });

  it("checks the stored shape strictly", () => {
    expect(isWorkingHours(null)).toBe(true);
    expect(isWorkingHours({})).toBe(true);
    expect(isWorkingHours({ sat: { start: "00:00", end: "23:59" } })).toBe(true);
    expect(isWorkingHours([])).toBe(false);
    expect(isWorkingHours({ sunday: { start: "09:00", end: "17:00" } })).toBe(false);
    expect(isWorkingHours({ sun: { start: "09:00", end: "24:00" } })).toBe(false);
    expect(isWorkingHours({ sun: { start: "09:00" } })).toBe(false);
    expect(isWorkingHours({ sun: { start: "09:00", end: "17:00", note: "x" } })).toBe(false);
    expect(isWorkingHours({ sun: { start: 9, end: 17 } })).toBe(false);
  });

  it("a malformed stored value reads as not set", () => {
    expect(readWorkingHours({ sun: "09-17" })).toBeNull();
    expect(readWorkingHours(undefined)).toBeNull();
    expect(readWorkingHours({ mon: { start: "09:00", end: "17:00" } })).toEqual({ mon: { start: "09:00", end: "17:00" } });
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

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { callbackGroups, callbackLabel, CALLBACK_SLOTS } from "@/features/intake/callback";
import { publicFormFrom } from "@/features/intake/public-form";

// found by name, so renumbering the migration at merge does not break the test
const MIGRATION = path.join(
  "supabase/migrations",
  readdirSync(path.join(process.cwd(), "supabase/migrations")).find((name) => name.endsWith("_callback_time.sql")) ?? "missing",
);

describe("call-back slots on the public form (SPD-05)", () => {
  it("offers today's slots that have not ended, and all of tomorrow's, in the business's zone", () => {
    // 10:30 in Jerusalem (summer, UTC+3)
    const groups = callbackGroups(new Date("2026-07-01T07:30:00Z"), "Asia/Jerusalem");
    expect(groups.map((g) => [g.label, g.options.map((o) => o.value)])).toEqual([
      ["היום", ["today-09", "today-12", "today-15", "today-18"]],
      ["מחר", ["tomorrow-09", "tomorrow-12", "tomorrow-15", "tomorrow-18"]],
    ]);
    expect(groups[0].options[1].label).toBe("12:00–15:00");
    // 17:59: the 15-18 and 18-20 slots are still open
    expect(callbackGroups(new Date("2026-07-01T14:59:00Z"), "Asia/Jerusalem")[0].options.map((o) => o.value)).toEqual(["today-15", "today-18"]);
    // 18:00: the 15-18 slot has ended
    expect(callbackGroups(new Date("2026-07-01T15:00:00Z"), "Asia/Jerusalem")[0].options.map((o) => o.value)).toEqual(["today-18"]);
    // 20:00: nothing is left today
    expect(callbackGroups(new Date("2026-07-01T17:00:00Z"), "Asia/Jerusalem").map((g) => g.label)).toEqual(["מחר"]);
    // the same instant is still morning in New York
    expect(callbackGroups(new Date("2026-07-01T17:00:00Z"), "America/New_York")[0].options.map((o) => o.value)).toEqual(["today-12", "today-15", "today-18"]);
    // a name Intl refuses or the database does not let through: Jerusalem
    const jerusalem = callbackGroups(new Date("2026-07-01T07:30:00Z"), "Asia/Jerusalem");
    for (const zone of ["Factory", "localtime", "Mars/Base", "", "EST5EDT,M3.2.0"]) {
      expect(callbackGroups(new Date("2026-07-01T07:30:00Z"), zone)).toEqual(jerusalem);
    }
  });

  it("names a choice the way the database does", () => {
    expect(callbackLabel("now")).toBe("עכשיו");
    expect(callbackLabel("today-09")).toBe("היום בין 09:00 ל-12:00");
    expect(callbackLabel("tomorrow-18")).toBe("מחר בין 18:00 ל-20:00");
    expect(callbackLabel("today-10")).toBeNull();
    expect(callbackLabel("later")).toBeNull();
  });

  it("uses the same slots as the migration", () => {
    const sql = readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
    const starts = CALLBACK_SLOTS.map((s) => s.start).join("|");
    // the pattern of both functions
    expect(sql.match(new RegExp(`\\^\\(today\\|tomorrow\\)-\\(${starts.replace(/\|/g, "\\|")}\\)\\$`, "g"))).toHaveLength(2);
    // the end of each slot in app.intake_callback_label() and app.intake_callback_at()
    const label = sql.slice(sql.indexOf("create or replace function app.intake_callback_label"), sql.indexOf("create or replace function app.intake_callback_at"));
    const at = sql.slice(sql.indexOf("create or replace function app.intake_callback_at"), sql.indexOf("create or replace function app.intake_callback_task"));
    for (const slot of CALLBACK_SLOTS.slice(0, -1)) {
      expect(label).toContain(`when '${slot.start}' then '${slot.end}'`);
      expect(at).toContain(`when ${Number(slot.start)} then ${Number(slot.end)}`);
    }
    const last = CALLBACK_SLOTS[CALLBACK_SLOTS.length - 1];
    expect(label).toContain(`else '${last.end}' end`);
    expect(at).toContain(`else ${Number(last.end)} end`);
  });

  it("reads the form's call-back setting from intake_form()", () => {
    const base = { title: "t", fields: [] };
    expect(publicFormFrom(base)?.callback).toBeNull();
    expect(publicFormFrom({ ...base, callback: null })?.callback).toBeNull();
    expect(publicFormFrom({ ...base, callback: { time_zone: "Asia/Jerusalem" } })?.callback).toEqual({ timeZone: "Asia/Jerusalem" });
  });
});

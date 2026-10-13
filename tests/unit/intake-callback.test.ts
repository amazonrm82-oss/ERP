import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CALLBACK_CHOICE, callbackOfferFrom, CALLBACK_SLOTS, isCallbackSlotStart, slotInputName, slotLabel } from "@/features/intake/callback";
import { publicFormFrom } from "@/features/intake/public-form";
import { callbackSlotsOff } from "@/features/intake/schema";

// found by name, so renumbering the migration at merge does not break the test
const migration = (suffix: string) =>
  path.join(
    "supabase/migrations",
    readdirSync(path.join(process.cwd(), "supabase/migrations")).find((name) => name.endsWith(suffix)) ?? "missing",
  );

describe("call-back slots on the public form (SPD-05)", () => {
  it("reads what intake_form() offers, dropping anything unexpected", () => {
    expect(callbackOfferFrom(null)).toBeNull();
    expect(callbackOfferFrom("x")).toBeNull();
    expect(
      callbackOfferFrom({
        time_zone: "Asia/Jerusalem",
        now: true,
        groups: [
          { label: "היום", options: [{ value: "2026-10-15-12", label: "12:00–15:00" }, { value: "2026-10-15-10", label: "x" }, { value: "now", label: "y" }, { value: "today-12", label: "z" }] },
          { label: "יום ראשון", options: [{ value: "2026-10-18-09", label: "09:00–12:00" }] },
          { label: "", options: [{ value: "2026-10-18-12", label: "12:00–15:00" }] },
          { label: "ריק", options: [] },
          "junk",
        ],
      }),
    ).toEqual({
      now: true,
      closedLine: null,
      groups: [
        { label: "היום", options: [{ value: "2026-10-15-12", label: "12:00–15:00" }] },
        { label: "יום ראשון", options: [{ value: "2026-10-18-09", label: "09:00–12:00" }] },
      ],
    });
    // "now" only when the database says so
    expect(callbackOfferFrom({ now: "yes", groups: [] })).toEqual({ now: false, closedLine: null, groups: [] });
    // a rest day: the line above the next working day's slots
    expect(callbackOfferFrom({ now: false, closed_line: "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום ראשון?", groups: [] })?.closedLine).toBe(
      "היום אנחנו סגורים. מתי נוח שנחזור אליך ביום ראשון?",
    );
  });

  it("reads the form's call-back setting from intake_form()", () => {
    const base = { title: "t", fields: [] };
    expect(publicFormFrom(base)?.callback).toBeNull();
    expect(publicFormFrom({ ...base, callback: null })?.callback).toBeNull();
    expect(publicFormFrom({ ...base, callback: { time_zone: "Asia/Jerusalem", now: false, groups: [] } })?.callback).toEqual({ now: false, closedLine: null, groups: [] });
  });

  it("uses the same slots as the migrations", () => {
    const starts = CALLBACK_SLOTS.map((s) => s.start);
    // the slot list of app.intake_callback_options() and the column's check
    const rules = readFileSync(path.join(process.cwd(), migration("_callback_slot_rules.sql")), "utf8");
    const values = CALLBACK_SLOTS.map((s) => `(${Number(s.start)}, ${Number(s.end)})`).join(", ");
    expect(rules).toContain(`(values ${values}) s(h_from, h_to)`);
    expect(rules).toContain(`callback_slots_off <@ array[${starts.map((s) => `'${s}'`).join(", ")}]::text[]`);
    // the shape of a slot's value: its business date and start hour
    expect(rules).toContain(`'^[0-9]{4}-[0-9]{2}-[0-9]{2}-(${starts.join("|")})$'`);
    expect(CALLBACK_CHOICE.test("2026-10-15-09")).toBe(true);
    expect(CALLBACK_CHOICE.test("now")).toBe(true);
    expect(CALLBACK_CHOICE.test("tomorrow-09")).toBe(false);
    // the TS pattern is the SQL one, plus "now"
    expect(CALLBACK_CHOICE.source).toBe(`^(now|\\d{4}-\\d{2}-\\d{2}-(${starts.join("|")}))$`);
  });

  it("the settings switches: one per slot, all on = nothing off", () => {
    expect(CALLBACK_SLOTS.map(slotLabel)).toEqual(["09:00–12:00", "12:00–15:00", "15:00–18:00", "18:00–20:00"]);
    expect(isCallbackSlotStart("09")).toBe(true);
    expect(isCallbackSlotStart("10")).toBe(false);
    const form = (on: string[]) => {
      const data = new FormData();
      for (const start of on) data.set(slotInputName(start as "09"), "on");
      return data;
    };
    expect(callbackSlotsOff(form(["09", "12", "15", "18"]))).toEqual([]);
    expect(callbackSlotsOff(form(["12", "15"]))).toEqual(["09", "18"]);
    expect(callbackSlotsOff(form([]))).toEqual(["09", "12", "15", "18"]);
  });
});

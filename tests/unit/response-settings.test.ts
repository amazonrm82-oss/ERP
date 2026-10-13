import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { responseSettingsSchema } from "@/features/response-target/schema";
import {
  BREACH_ACTIONS,
  clockNote,
  DEFAULT_RESPONSE_SETTINGS,
  effectiveBreachAction,
  PASSES_MAX,
  PASSES_MIN,
  responseSettingsFrom,
  TARGET_MAX,
  TARGET_MIN,
  targetText,
} from "@/features/response-target/settings";

const dir = join(process.cwd(), "supabase/migrations");
// the latest migration that sets the action check (SPD-03 widens it)
const actionCheck = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(dir, f), "utf8"))
  .flatMap((sql) => [...sql.matchAll(/lead_response_settings_action_check check \(breach_action in \(([^)]*)\)\)/g)].map((m) => m[1]))
  .at(-1);
const created = readdirSync(dir)
  .filter((f) => f.endsWith("_response_target.sql"))
  .map((f) => readFileSync(join(dir, f), "utf8"))[0];
const passes = readdirSync(dir)
  .filter((f) => f.endsWith("_lead_pass_on.sql"))
  .map((f) => readFileSync(join(dir, f), "utf8"))[0];

/** CAP-10: the response target setting, as the table checks it. */
describe("response target settings", () => {
  it("the range and the actions are the table's", () => {
    expect(created).toContain(`check (target_minutes between ${TARGET_MIN} and ${TARGET_MAX})`);
    expect([...(actionCheck ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1])).toEqual([...BREACH_ACTIONS]);
    expect(created).toContain("target_minutes  integer not null default 60");
    expect(created).toContain("breach_action   text not null default 'notify'");
    expect(passes).toContain(`check (max_passes between ${PASSES_MIN} and ${PASSES_MAX})`);
    expect(passes).toContain("max_passes integer not null default 2");
  });

  it("no row reads as 60 minutes and notify", () => {
    expect(responseSettingsFrom(null)).toEqual(DEFAULT_RESPONSE_SETTINGS);
    expect(DEFAULT_RESPONSE_SETTINGS).toEqual({ targetMinutes: 60, breachAction: "notify", maxPasses: 2 });
    expect(responseSettingsFrom({ target_minutes: 15, breach_action: "pass_on", max_passes: 3 })).toEqual({ targetMinutes: 15, breachAction: "pass_on", maxPasses: 3 });
    expect(responseSettingsFrom({ target_minutes: 15, breach_action: "later", max_passes: 2 }).breachAction).toBe("notify");
  });

  it("the form takes whole minutes in range and a known action", () => {
    expect(responseSettingsSchema.parse({ target_minutes: " 30 ", breach_action: "pass_on", max_passes: "3" })).toEqual({ target_minutes: 30, breach_action: "pass_on", max_passes: 3 });
    for (const bad of ["4", "1441", "12.5", "", "abc", null]) {
      expect(responseSettingsSchema.safeParse({ target_minutes: bad, breach_action: "notify", max_passes: "2" }).success, String(bad)).toBe(false);
    }
    for (const bad of ["0", "6", "1.5", ""]) {
      expect(responseSettingsSchema.safeParse({ target_minutes: "60", breach_action: "pass_on", max_passes: bad }).success, bad).toBe(false);
    }
    expect(responseSettingsSchema.safeParse({ target_minutes: "60", breach_action: "bogus", max_passes: "2" }).success).toBe(false);
  });

  it("passing on runs only with the plan flag; otherwise the managers are notified (SPD-03)", () => {
    expect(effectiveBreachAction("pass_on", true)).toBe("pass_on");
    expect(effectiveBreachAction("pass_on", false)).toBe("notify");
    expect(effectiveBreachAction("none", false)).toBe("none");
  });

  it("the target in words", () => {
    expect(targetText(5)).toBe("5 דקות");
    expect(targetText(90)).toBe("90 דקות");
    expect(targetText(120)).toBe("2 שעות");
    expect(targetText(150)).toBe("2 שעות ו-30 דקות");
    expect(targetText(1440)).toBe("24 שעות");
  });

  it("the clock note says whether the business's hours count", () => {
    expect(clockNote(true)).toContain("בשעות העבודה");
    expect(clockNote(false)).toContain("לא הוגדרו שעות עבודה");
  });
});

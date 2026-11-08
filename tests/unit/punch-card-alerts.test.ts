import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { daysUntil, expiryDaysText, expiryNear, lowEntriesText, PUNCH_ALERT_DEFAULTS, punchAlertSettingsSchema, punchAlertTitle, punchEntriesText } from "@/features/punch-cards/alerts";
import { punchBalance } from "@/features/punch-cards/balance";

import { latestMigration } from "./helpers/migrations";

const entries = JSON.parse(readFileSync("tests/unit/fixtures/punch-card-entries.json", "utf8")) as Array<{ left: number; text: string }>;

// PKG-03: the alert numbers, the contact card's badges and the notice titles the database writes.
describe("punch card alerts (PKG-03)", () => {
  const sql = latestMigration("create or replace function app.punch_card_alert_title")?.sql ?? "";
  const settingsSql = latestMigration("create table if not exists public.punch_card_alert_settings")?.sql ?? "";

  it("the defaults and ranges equal the table's", () => {
    expect(settingsSql).toContain(`low_entries      smallint not null default ${PUNCH_ALERT_DEFAULTS.lowEntries}`);
    expect(settingsSql).toContain(`expiry_days      smallint not null default ${PUNCH_ALERT_DEFAULTS.expiryDays}`);
    expect(settingsSql).toContain("check (low_entries between 0 and 100)");
    expect(settingsSql).toContain("check (expiry_days between 0 and 365)");
    // the job's fallbacks are the same defaults
    expect(sql).toContain(`coalesce(p_low_entries, s.low_entries, ${PUNCH_ALERT_DEFAULTS.lowEntries})`);
    expect(sql).toContain(`coalesce(p_expiry_days, s.expiry_days, ${PUNCH_ALERT_DEFAULTS.expiryDays})`);
    // the settings baseline compares an insert with the same defaults (no row before it)
    expect(sql).toContain(`v_old_low integer := ${PUNCH_ALERT_DEFAULTS.lowEntries};`);
    expect(sql).toContain(`v_old_expiry integer := ${PUNCH_ALERT_DEFAULTS.expiryDays};`);
  });

  it("the titles are the database's", () => {
    const body = sql.slice(sql.indexOf("create or replace function app.punch_card_alert_title"), sql.indexOf("revoke all on function app.punch_card_alert_title"));
    // owner (138) ב: the few-left title is "כרטיסייה: " and the {כניסות} phrase
    expect(body).toContain("when p_kind = 'low' then 'כרטיסייה: ' || app.punch_card_entries_text(p_remaining)");
    expect(punchAlertTitle("low", 1, 0)).toBe("כרטיסייה: נשארה כניסה אחת");
    expect(punchAlertTitle("low", 0, 0)).toBe("כרטיסייה: לא נשארו כניסות");
    expect(body).toContain(`'${punchAlertTitle("expiry", 3, 0)}'`);
    expect(body).toContain(`'${punchAlertTitle("expiry", 3, 1)}'`);
    expect(body).toContain(`'${punchAlertTitle("expiry", 3, 9).replace("9", "' || p_days || '")}'`);
    // card name and numbers only: no record word of the business's terms (FLD-10)
    for (const word of ["ליד", "איש קשר", "עסקה"]) expect(body).not.toContain(word);
  });

  it("the {כניסות} phrase equals the shared fixture and the database's literals (owner (138) ב)", () => {
    for (const c of entries) expect(punchEntriesText(c.left), String(c.left)).toBe(c.text);
    const fn = latestMigration("create or replace function app.punch_card_entries_text")?.sql ?? "";
    expect(fn).toContain("'לא נשארו כניסות'");
    expect(fn).toContain("'נשארה כניסה אחת'");
    expect(fn).toContain("'נשארו ' || p_left || ' כניסות'");
  });

  it("the few-left badge follows the business's number, and 0 switches it off", () => {
    const card = { status: "active", entriesTotal: 10, expiresOn: null };
    expect(punchBalance(card, 7, "2026-11-08").low).toBe(false);
    expect(punchBalance(card, 7, "2026-11-08", 3).low).toBe(true);
    expect(punchBalance(card, 9, "2026-11-08", 0).low).toBe(false);
    // used up is not "few left"
    expect(punchBalance(card, 10, "2026-11-08", 3).low).toBe(false);
  });

  it("the last day near: within the business's days, from today, never for an unusable card", () => {
    expect(daysUntil("2026-11-22", "2026-11-08")).toBe(14);
    expect(daysUntil("2026-03-29", "2026-03-26")).toBe(3);
    expect(expiryNear({ usable: true, expiresOn: "2026-11-22" }, "2026-11-08", 14)).toBe(true);
    expect(expiryNear({ usable: true, expiresOn: "2026-11-23" }, "2026-11-08", 14)).toBe(false);
    expect(expiryNear({ usable: true, expiresOn: "2026-11-08" }, "2026-11-08", 14)).toBe(true);
    expect(expiryNear({ usable: true, expiresOn: "2026-11-10" }, "2026-11-08", 0)).toBe(false);
    expect(expiryNear({ usable: false, expiresOn: "2026-11-10" }, "2026-11-08", 14)).toBe(false);
    expect(expiryNear({ usable: true, expiresOn: null }, "2026-11-08", 14)).toBe(false);
  });

  it("the form takes whole numbers in range, 0 included", () => {
    expect(punchAlertSettingsSchema.safeParse({ low_entries: "0", expiry_days: "365" }).success).toBe(true);
    expect(punchAlertSettingsSchema.safeParse({ low_entries: "101", expiry_days: "14" }).success).toBe(false);
    expect(punchAlertSettingsSchema.safeParse({ low_entries: "2", expiry_days: "1.5" }).success).toBe(false);
    expect(punchAlertSettingsSchema.safeParse({ low_entries: "", expiry_days: "14" }).success).toBe(false);
  });

  it("says the numbers in words", () => {
    expect(lowEntriesText(0)).toBe("כבויה");
    expect(lowEntriesText(1)).toBe("כשנשארה כניסה אחת");
    expect(lowEntriesText(2)).toBe("כשנשארו 2 כניסות או פחות");
    expect(expiryDaysText(0)).toBe("כבויה");
    expect(expiryDaysText(14)).toBe("14 ימים לפני סוף התוקף");
  });
});

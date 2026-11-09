import { describe, expect, it } from "vitest";

import { PUNCH_ALERT_DEFAULTS, punchAlertSettingsSchema } from "@/features/punch-cards/alerts";
import { isNoticesTo, NOTICES_TO, recipientLine, recipientOptionLabel } from "@/features/punch-cards/recipients";
import { dbErrorMessage, GENERIC_ERROR } from "@/lib/errors";

import { latestMigration } from "./helpers/migrations";

// PKG-06: a punch card line's service recipient (owner (149)-(151)).
describe("payer and service recipient (PKG-06)", () => {
  const sql = latestMigration("add column if not exists notices_to")?.sql ?? "";

  it("the notices choice equals the table's, with the same default", () => {
    expect(sql).toContain(`notices_to text not null default '${PUNCH_ALERT_DEFAULTS.noticesTo}'`);
    expect(sql).toContain(`check (notices_to in (${NOTICES_TO.map((v) => `'${v}'`).join(", ")}))`);
    expect(isNoticesTo("payer")).toBe(true);
    expect(isNoticesTo("recipient")).toBe(false);
  });

  it("the settings form keeps the default when it has no choice, and refuses anything else", () => {
    const base = { low_entries: "2", expiry_days: "14" };
    expect(punchAlertSettingsSchema.parse(base).notices_to).toBe("both");
    expect(punchAlertSettingsSchema.parse({ ...base, notices_to: "payer" }).notices_to).toBe("payer");
    expect(punchAlertSettingsSchema.safeParse({ ...base, notices_to: "everyone" }).success).toBe(false);
  });

  it("the texts", () => {
    expect(recipientLine(null)).toBe("מקבל השירות: המשלם עצמו");
    expect(recipientLine("דנה")).toBe("מקבל השירות: דנה");
    expect(recipientOptionLabel({ id: "x", name: "יואב", how: "employee" })).toBe("יואב (עובד בחברה המשלמת)");
    expect(recipientOptionLabel({ id: "x", name: "", how: "relation" })).toBe("ללא שם (קשר של המשלם)");
  });

  it("every hint the database raises has a Hebrew message", () => {
    for (const hint of ["punch_recipient:line", "punch_recipient:contact", "punch_recipient:not_linked"]) {
      expect(sql).toContain(`hint = '${hint}'`);
      expect(dbErrorMessage({ code: "P0001", hint, message: "x" })).not.toBe(GENERIC_ERROR);
    }
  });
});

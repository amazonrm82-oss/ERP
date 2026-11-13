import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditEntryNote } from "@/features/audit/condition-removal";
import { ACTION_LABELS } from "@/features/audit/labels";
import { notificationHref } from "@/features/notifications/links";
import { orgDeletionPath } from "@/features/org-deletion/paths";
import {
  codeSchema,
  confirmReasonText,
  CONFIRM_REASON_TEXT,
  deletionBannerText,
  deletionDayText,
  deletionStatusFrom,
  NO_DELETION,
  typedNameMatches,
} from "@/features/org-deletion/texts";
import { settingsAccessFor, settingsGroups } from "@/features/settings/sections";
import { dbErrorMessage } from "@/lib/errors";

// ADM-03 (owner, 13 November 2026, answers (361) ב, (362) ב, (363) ב)

describe("the deletion's words", () => {
  it("the code from the email: digits only, 6 to 10", () => {
    expect(codeSchema.safeParse({ code: " 854701 " }).success).toBe(true);
    expect(codeSchema.safeParse({ code: "85470" }).success).toBe(false);
    expect(codeSchema.safeParse({ code: "85470a" }).success).toBe(false);
  });

  it("the banner: nothing unless pending; the owner and the others", () => {
    expect(deletionBannerText(NO_DELETION, "1 בינואר", true)).toBeNull();
    const pending = deletionStatusFrom({ pending: true, scheduled_for: "2026-12-13T08:00:00Z", confirmed_at: "x", awaiting_until: null });
    expect(deletionBannerText(pending, null, true)).toBeNull();
    expect(deletionBannerText(pending, "13 בדצמבר 2026", true)).toBe("העסק יימחק ב-13 בדצמבר 2026. עד אז אפשר רק לקרוא ולייצא.");
    expect(deletionBannerText(pending, "13 בדצמבר 2026", false)).toContain("פנו לבעל העסק");
    expect(deletionDayText("2026-12-13T23:30:00Z", "Asia/Jerusalem")).toContain("14");
    expect(deletionDayText("nope", "Asia/Jerusalem")).toBe("");
    expect(deletionDayText(null, "Asia/Jerusalem")).toBe("");
  });

  it("a malformed status reads as nothing pending", () => {
    expect(deletionStatusFrom(null)).toEqual(NO_DELETION);
    expect(deletionStatusFrom({ pending: "yes" })).toEqual(NO_DELETION);
  });

  it("the typed name is compared as the database compares it", () => {
    expect(typedNameMatches("  עסק  ", "עסק")).toBe(true);
    expect(typedNameMatches("", "")).toBe(false);
    expect(typedNameMatches("עסק אחר", "עסק")).toBe(false);
  });

  it("every confirmation answer has a Hebrew line; an unknown one reads as invalid", () => {
    for (const reason of ["invalid", "expired", "mfa", "pending", "no_code", "email_change", "code", "tries"]) expect(CONFIRM_REASON_TEXT[reason]).toBeTruthy();
    expect(confirmReasonText("other")).toBe(CONFIRM_REASON_TEXT.invalid);
    expect(confirmReasonText(undefined)).toBe(CONFIRM_REASON_TEXT.invalid);
  });

  it("the database's hints, the audit entries and the notice link are known", () => {
    for (const hint of ["org_deletion:mfa", "org_deletion:name", "org_deletion:pending", "org_deletion:rate", "org_deletion:read_only"]) {
      expect(dbErrorMessage({ code: "P0001", hint, message: "" }, "__fallback__"), hint).not.toBe("__fallback__");
    }
    expect(ACTION_LABELS.org_deletion).toBe("מחיקת העסק");
    expect(auditEntryNote("org_deletion", { step: "confirmed" })).toContain("קריאה בלבד");
    expect(auditEntryNote("org_deletion", { step: "other" })).toBeNull();
    expect(notificationHref("o1", "org_deletion", "o1")).toBe(orgDeletionPath("o1"));
  });

  it("only the owner sees the settings section", () => {
    const has = (role: "owner" | "admin") =>
      settingsGroups("o1", settingsAccessFor({ role, canWrite: true, canDelete: true, priceLists: false, granted: [] }))
        .flatMap((g) => g.sections)
        .some((s) => s.href === orgDeletionPath("o1"));
    expect(has("owner")).toBe(true);
    expect(has("admin")).toBe(false);
  });

  it("the code is asked of Supabase Auth with the owner's own session, never with a service key", () => {
    const actions = readFileSync(join(__dirname, "../../src/features/org-deletion/actions.ts"), "utf8");
    expect(actions.startsWith('"use server"')).toBe(true);
    expect(actions).toContain("supabase.auth.reauthenticate()");
    expect(actions).not.toMatch(/supabase\/service|SECRET_KEY|SERVICE_ROLE/);
  });
});

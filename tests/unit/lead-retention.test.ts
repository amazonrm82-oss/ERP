import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditEntryNote } from "@/features/audit/condition-removal";
import { ACTION_LABELS, ENTITY_LABELS } from "@/features/audit/labels";
import { formatDayIn, leadCountText, previewText, retentionRowState, RETENTION_MONTHS_MAX, RETENTION_MONTHS_MIN, RETENTION_NOTICE_DAYS } from "@/features/lead-retention/model";
import { retentionListPath, retentionSettingsPath } from "@/features/lead-retention/paths";
import { notificationHref } from "@/features/notifications/links";
import { settingsAccessFor, settingsGroups } from "@/features/settings/sections";
import { resolveTerms } from "@/features/terminology/terms";
import { dbErrorMessage } from "@/lib/errors";

// PRV-01: the retention policy's app side: bounds equal to the database's, the preview wording, audit notes, the notice's link
const migration = readdirSync(join(process.cwd(), "supabase/migrations"))
  .filter((f) => f.endsWith("_lead_retention.sql"))
  .map((f) => readFileSync(join(process.cwd(), "supabase/migrations", f), "utf8"))
  .join("\n");

const words = { singular: "ליד", plural: "לידים", oneWord: "אחד" };

describe("lead retention (PRV-01)", () => {
  it("keeps the database's bounds and notice", () => {
    expect(migration).toContain(`check (months between ${RETENTION_MONTHS_MIN} and ${RETENTION_MONTHS_MAX})`);
    expect(migration).toContain(`interval '${RETENTION_NOTICE_DAYS} days'`);
  });

  it("says how many leads the first list will hold", () => {
    expect(leadCountText(1, "פנייה", "פניות", "אחת")).toBe("פנייה אחת");
    expect(leadCountText(1200, "ליד", "לידים", "אחד")).toBe("1,200 לידים");
    expect(previewText({ months: 12, now: 0, within_notice: 0 }, words)).toBe("אין היום לידים בלי קשר 12 חודשים. המדיניות תתחיל לפעול כשיהיו.");
    expect(previewText({ months: 12, now: 5, within_notice: 5 }, words)).toMatch(/^5 לידים ייכנסו לרשימה הראשונה\./);
    expect(previewText({ months: 12, now: 4, within_notice: 6 }, words)).toMatch(/^6 לידים \(4 מהם כבר היום\) ייכנסו/);
  });

  it("says a row's state in neutral words, and dates in the business's zone", () => {
    expect(retentionRowState({ binned: true, skipped: false, kept_at: null })).toBe("בסל המחזור");
    expect(retentionRowState({ binned: false, skipped: false, kept_at: "2026-10-26T10:00:00Z" })).toBe("סומן להשאיר");
    expect(retentionRowState({ binned: false, skipped: true, kept_at: null })).toBe("פעיל שוב");
    expect(retentionRowState({ binned: false, skipped: false, kept_at: null })).toBeNull();
    // 23:30 UTC on 26 October is already 27 October in Jerusalem, still 26 October in New York
    expect(formatDayIn("2026-10-26T23:30:00Z", "Asia/Jerusalem")).toContain("27");
    expect(formatDayIn("2026-10-26T23:30:00Z", "America/New_York")).toContain("26");
    expect(formatDayIn(null, "Asia/Jerusalem")).toBe("");
  });

  it("names its audit entries and says what they did", () => {
    expect(ENTITY_LABELS.lead_retention).toBeTruthy();
    for (const action of ["retention_policy", "retention_keep", "retention_purge"]) expect(ACTION_LABELS[action], action).toBeTruthy();
    // the core's per-lead row, renamed from 'erase' by app.lead_retention_erase (owner, 26 October 2026)
    expect(ACTION_LABELS.retention).toBe("נמחק לפי מדיניות השמירה");
    expect(migration).toContain("set action = 'retention'");
    expect(auditEntryNote("retention_purge", { count: 3 })).toBe("המדיניות מחקה 3 לידים");
    expect(auditEntryNote("retention_purge", { count: 1 })).toBe("המדיניות מחקה ליד אחד");
    // in the business's words (FLD-10)
    const inquiry = resolveTerms({ contact: "patient", lead: "inquiry", deal: "opportunity" });
    expect(auditEntryNote("retention_purge", { count: 1 }, inquiry)).toBe("המדיניות מחקה פנייה אחת");
    expect(auditEntryNote("retention_purge", { count: 3 }, inquiry)).toBe("המדיניות מחקה 3 פניות");
    expect(auditEntryNote("retention_policy", { enabled: true, months: 12, previous_enabled: false, previous_months: null })).toBe(
      "המדיניות הופעלה: 12 חודשים בלי קשר",
    );
    expect(auditEntryNote("retention_policy", { enabled: true, months: 18, previous_enabled: true, previous_months: 12 })).toBe(
      "מספר החודשים שונה מ-12 ל-18",
    );
    expect(auditEntryNote("retention_policy", { enabled: false, months: 18, previous_enabled: true, previous_months: 18 })).toBe("המדיניות כובתה");
  });

  it("answers its hints in Hebrew", () => {
    for (const hint of ["retention:months", "retention:confirm", "retention:not_listed"]) {
      expect(dbErrorMessage({ code: "P0001", hint, message: "" }, "__fallback__"), hint).not.toBe("__fallback__");
    }
  });

  it("the notice opens the list; the section is for owners and admins", () => {
    expect(notificationHref("org-1", "lead_retention", "round-1")).toBe(retentionListPath("org-1"));
    expect(notificationHref("org-1", "lead_retention_binned", "round-1")).toBe("/o/org-1/settings/trash");
    expect(retentionListPath("org-1", 2)).toBe("/o/org-1/settings/retention/list?page=2");
    const hrefs = (role: "owner" | "member") =>
      settingsGroups("org-1", settingsAccessFor({ role, canWrite: true, canDelete: false, priceLists: false, granted: [] })).flatMap((g) =>
        g.sections.map((s) => s.href),
      );
    expect(hrefs("owner")).toContain(retentionSettingsPath("org-1"));
    expect(hrefs("member")).not.toContain(retentionSettingsPath("org-1"));
  });
});

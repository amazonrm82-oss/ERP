import { describe, expect, it } from "vitest";

import {
  canSeeCleanup,
  CLEANUP_FAILED_MESSAGE,
  CLEANUP_TIMEOUT_MESSAGE,
  cleanupLoadMessage,
  cleanupMatchText,
  cleanupSchema,
  rareOptionText,
} from "@/features/data-quality/cleanup";
import { notificationHref } from "@/features/notifications/links";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// DQL-03: the shape public.cleanup_suggestions answers (tests/db/284 runs the SQL) and the screen's texts
describe("cleanup suggestions (DQL-03)", () => {
  const sample = {
    allowed: true,
    since: "2026-10-03T10:00:00+00:00",
    duplicates: {
      count: 1,
      items: [{ type: "lead", id: id(1), name: "דנה", created_at: "2026-11-01T10:00:00+00:00", other_id: id(2), other_name: null, match: "phone" }],
    },
    unowned_leads: { count: 1, items: [{ id: id(3), name: null, created_at: "2026-10-01T10:00:00+00:00" }] },
    no_channel: { count: 2, leads: 1, contacts: 1, items: [{ type: "contact", id: id(4), name: "רון", created_at: "2026-10-01T10:00:00+00:00" }] },
    rare_options: {
      count: 1,
      min_filled: 50,
      max_used: 1,
      items: [{ object_type: "deal", field_key: "size", field_label: "גודל", option: "ענק", used: 0, filled: 1200 }],
    },
  };

  it("parses the database's answer and refuses an unknown match or type", () => {
    const parsed = cleanupSchema.parse(sample);
    expect(parsed.allowed && parsed.duplicates.items[0].match).toBe("phone");
    expect(cleanupSchema.parse({ allowed: false })).toEqual({ allowed: false });
    const bad = structuredClone(sample);
    bad.duplicates.items[0].match = "fax";
    expect(() => cleanupSchema.parse(bad)).toThrow();
    const badType = structuredClone(sample);
    badType.no_channel.items[0].type = "deal";
    expect(() => cleanupSchema.parse(badType)).toThrow();
  });

  it("says why a record looks like a duplicate and how rare an option is", () => {
    expect(cleanupMatchText("tax_id")).toBe("אותו ח.פ.");
    expect(rareOptionText(0, 1200)).toBe("לא בשימוש באף רשומה מתוך 1,200 שבהן השדה מלא");
    expect(rareOptionText(1, 50)).toBe("בשימוש ברשומה אחת מתוך 50 שבהן השדה מלא");
  });

  it("is for owners, admins and managers; the weekly notice opens the page", () => {
    expect(["owner", "admin", "manager", "member", "viewer", null].map((r) => canSeeCleanup(r))).toEqual([true, true, true, false, false, false]);
    expect(notificationHref("org-1", "cleanup_suggestions", "org-1")).toBe("/o/org-1/reports/cleanup");
  });

  it("a statement timeout and any other failed read become a Hebrew line, never the error page", () => {
    expect(cleanupLoadMessage({ code: "57014" })).toBe(CLEANUP_TIMEOUT_MESSAGE);
    expect(CLEANUP_TIMEOUT_MESSAGE).toBe("ההצעות לא נטענו: יש יותר מדי רשומות לבדיקה כרגע. ההתראה השבועית ממשיכה לספור.");
    expect(cleanupLoadMessage({ code: "42501" })).toBe(CLEANUP_FAILED_MESSAGE);
    expect(cleanupLoadMessage(null)).toBe(CLEANUP_FAILED_MESSAGE);
  });
});

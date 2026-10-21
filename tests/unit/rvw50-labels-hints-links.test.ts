import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { auditEntryNote } from "@/features/audit/condition-removal";
import { ACTION_LABELS, ENTITY_LABELS } from "@/features/audit/labels";
import { notificationHref } from "@/features/notifications/links";
import { dbErrorMessage } from "@/lib/errors";

// RVW-50: the audit log, the error messages and the notification links know the newer entries, hints and notices.

const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), "utf8"))
  .join("\n");

describe("audit log labels (RVW-50 א)", () => {
  it("names the person removal and the customer links of quotes and orders", () => {
    expect(ACTION_LABELS.person_erase).toBe("מחיקת אדם מכל מקום (בקשת פרטיות)");
    expect(ENTITY_LABELS.person_erase).toBe("אדם שנמחק");
    expect(ACTION_LABELS.quote_link).toBe("קישור ללקוח להצעה");
    expect(ACTION_LABELS.order_link).toBe("קישור ללקוח להזמנה");
  });

  it("every action and entity type the migrations write to the audit log has a Hebrew label", () => {
    const written = [...sql.matchAll(/insert into public\.audit_log \([^)]*\)\s*values \([^,]+, [^,]+, '([a-z_]+)', '([a-z_]+)'/g)];
    expect(written.length).toBeGreaterThan(5);
    for (const [, action, entity] of written) {
      expect(ACTION_LABELS[action], action).toBeTruthy();
      expect(ENTITY_LABELS[entity], entity).toBeTruthy();
    }
  });

  it("says what a link entry and a removal did", () => {
    expect(auditEntryNote("quote_link", { link: "created" })).toBe("נוצר קישור חדש ללקוח (קישור קודם, אם היה, הפסיק לעבוד)");
    expect(auditEntryNote("order_link", { link: "revoked" })).toBe("הקישור ללקוח בוטל");
    expect(auditEntryNote("order_link", { link: "other" })).toBeNull();
    expect(auditEntryNote("person_erase", { reason: " בקשה בטלפון ", counts: { leads: 1 } })).toBe("סיבה: בקשה בטלפון");
    expect(auditEntryNote("person_erase", { reason: "" })).toBeNull();
    expect(auditEntryNote("update", { link: "created" })).toBeNull();
    // the existing note still comes through
    expect(auditEntryNote("conditions_removed", { fields: [{ key: "po", label: "הזמנת רכש", removed: true }] })).toContain("הזמנת רכש");
  });
});

describe("Hebrew messages for the database's hints (RVW-50 ב)", () => {
  const FALLBACK = "__fallback__";
  const message = (hint: string) => dbErrorMessage({ code: "P0001", hint, message: "" }, FALLBACK);

  it("the three hints of the review have their own message", () => {
    for (const hint of ["order_lines:price_list", "quote_deal:no_deal", "quote_deal:not_accepted"]) {
      expect(message(hint), hint).not.toBe(FALLBACK);
    }
  });

  // hints whose screen answers them itself; the guard checks that the named file really does
  const HANDLED_ELSEWHERE: Record<string, string> = {
    "booking:closed": "src/features/booking/public-server.ts",
    "booking:too_late": "src/features/booking/public-server.ts",
    "booking:unavailable": "src/features/booking/public-server.ts",
    "leave:open": "src/features/suspended/actions.ts",
    "merge:both_converted": "src/features/merge/actions.ts",
    "mfa:self_first": "src/features/settings/actions.ts",
    "mfa_reset:none": "src/features/settings/actions.ts",
    "mfa_reset:other_orgs": "src/features/settings/actions.ts",
    "org:suspended": "src/features/calendar-feed/actions.ts",
    "person_erase:deal_name": "src/features/privacy-erase/actions.ts",
    "person_erase:reason": "src/features/privacy-erase/actions.ts",
    "platform:last_owner": "src/features/platform/actions.ts",
    "quote_deal:closed": "src/features/deals/actions.ts",
    "rate_limited": "src/features/site-widgets/public-server.ts",
    "transfer:target": "src/features/settings/actions.ts",
  };
  // raised only by server paths no person reaches (a merge copying consents between records of the business)
  const SERVER_ONLY = new Set(["consent:copy"]);

  it("every P0001 hint the migrations raise has a message, is answered by its screen, or is server-only", () => {
    const hints = new Set([...sql.matchAll(/errcode = 'P0001', hint = '([a-z_:]+)'/g)].map((m) => m[1]));
    expect(hints.size).toBeGreaterThan(100);
    const missing = [...hints].filter(
      (hint) => !hint.startsWith("limit:") && !hint.startsWith("feature:") && !(hint in HANDLED_ELSEWHERE) && !SERVER_ONLY.has(hint) && message(hint) === FALLBACK,
    );
    expect(missing).toEqual([]);
    for (const [hint, file] of Object.entries(HANDLED_ELSEWHERE)) {
      expect(readFileSync(join(process.cwd(), file), "utf8"), `${hint} in ${file}`).toContain(hint);
    }
  });
});

describe("notification links (RVW-50 ג)", () => {
  it("the deputy-chosen notice opens the users list", () => {
    expect(notificationHref("org-1", "member_leaves", "leave-1")).toBe("/o/org-1/settings/users");
    expect(notificationHref("org-1", "member_leaves", null)).toBeNull();
  });
});

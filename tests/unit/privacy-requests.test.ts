import { describe, expect, it } from "vitest";

import { auditEntryNote } from "@/features/audit/condition-removal";
import { ACTION_LABELS, ENTITY_LABELS } from "@/features/audit/labels";
import { notificationHref } from "@/features/notifications/links";
import {
  isOverdue,
  nextStatuses,
  PRIVACY_REQUEST_STATUSES,
  PRIVACY_REQUEST_TYPES,
  PRIVACY_VERIFY_METHODS,
  privacyPageFrom,
  publicRequestSchema,
  refusalReasonFrom,
  targetLine,
} from "@/features/privacy-requests/model";
import { migrationNames, migrationText } from "./helpers/migrations";

// PRK-02: the app's closed lists equal the migration's checks; the overdue rule; the public form's rules.

const sql = migrationText(migrationNames().find((name) => name.endsWith("_privacy_requests.sql"))!);
const listIn = (constraint: string) => {
  const match = sql.match(new RegExp(`constraint ${constraint} check \\([^)]*in \\(([^)]*)\\)`));
  return [...(match?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
};

describe("privacy requests (PRK-02)", () => {
  it("the closed lists mirror the migration", () => {
    expect(listIn("privacy_requests_type")).toEqual([...PRIVACY_REQUEST_TYPES]);
    expect(listIn("privacy_requests_status")).toEqual([...PRIVACY_REQUEST_STATUSES]);
    expect(listIn("privacy_requests_verify_method")).toEqual([...PRIVACY_VERIFY_METHODS]);
  });

  it("an open request past its target day is overdue; a closed one never", () => {
    expect(isOverdue("new", "2026-11-01", "2026-11-02")).toBe(true);
    expect(isOverdue("in_progress", "2026-11-02", "2026-11-02")).toBe(false);
    expect(isOverdue("done", "2026-11-01", "2026-11-20")).toBe(false);
    expect(isOverdue("refused", "2026-11-01", "2026-11-20")).toBe(false);
    expect(targetLine("new", "2026-11-03", "2026-11-02")).toBe("נשאר יום");
    expect(targetLine("new", "2026-11-02", "2026-11-02")).toBe("היום");
    expect(targetLine("verifying", "2026-11-01", "2026-11-02")).toBe("באיחור של יום");
    expect(targetLine("verifying", "2026-10-30", "2026-11-02")).toBe("באיחור של 3 ימים");
    expect(targetLine("done", "2026-10-30", "2026-11-02")).toBeNull();
  });

  it("work and closing wait for the identity check", () => {
    expect(nextStatuses("new", false)).toEqual(["verifying"]);
    expect(nextStatuses("verifying", true)).toEqual(["in_progress", "done"]);
    expect(nextStatuses("done", true)).toEqual([]);
  });

  it("the public form takes a type, a name, one contact and optional text", () => {
    const good = { request_type: "erasure", name: " דנה ", contact_kind: "phone", contact_value: "050-1234567" };
    const parsed = publicRequestSchema.safeParse(good);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.name).toBe("דנה");
    for (const bad of [
      { ...good, request_type: "all" },
      { ...good, name: "" },
      { ...good, contact_value: "12" },
      { ...good, contact_kind: "email", contact_value: "nope" },
      { ...good, details: "א".repeat(2001) },
    ]) {
      expect(publicRequestSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it("a refusal takes a ready reason (junk included) or the words typed for another one", () => {
    expect(refusalReasonFrom("בקשה לא רצינית / ספאם", "")).toBe("בקשה לא רצינית / ספאם");
    expect(refusalReasonFrom("other", "  הבקשה כפולה ")).toBe("הבקשה כפולה");
    expect(refusalReasonFrom("other", " ")).toBeNull();
    expect(refusalReasonFrom("anything", "x")).toBeNull();
  });

  it("the page reads only the business's name and brand", () => {
    expect(privacyPageFrom({ business: "העסק", brand: { logo: null, color: "#112233" }, built_with: false })).toEqual({
      business: "העסק",
      logoPath: null,
      color: "#112233",
      builtWith: false,
    });
    expect(privacyPageFrom({ rate_limited: true })).toBeNull();
  });

  it("the notice opens the request; the audit log names the link and the table", () => {
    expect(notificationHref("org-1", "privacy_request", "req-1")).toBe("/o/org-1/settings/privacy/requests/req-1");
    expect(notificationHref("org-1", "privacy_requests", "org-1")).toBe("/o/org-1/settings/privacy/requests");
    expect(ACTION_LABELS.privacy_request_link).toBeTruthy();
    expect(ENTITY_LABELS.privacy_requests).toBeTruthy();
    expect(auditEntryNote("privacy_request_link", { link: "revoked" })).toBe("הקישור לבקשות פרטיות בוטל");
  });
});

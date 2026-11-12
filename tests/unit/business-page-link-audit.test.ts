import { describe, expect, it } from "vitest";

import { auditEntryNote } from "@/features/audit/condition-removal";
import { ACTION_LABELS } from "@/features/audit/labels";

// BIZ-01 (316) ב: the audit log names a new business page link in Hebrew (the entry holds no token)
describe("business page link audit entry", () => {
  it("has a label and a note", () => {
    expect(ACTION_LABELS.business_page_link).toBe("קישור לדף העסק");
    expect(auditEntryNote("business_page_link", { link: "created" })).toBe("נוצר קישור חדש לדף העסק (הקישור הקודם הפסיק לעבוד)");
    expect(auditEntryNote("business_page_link", { link: "other" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { settingsAccessFor, settingsGroups } from "@/features/settings/sections";
import { detachedSignatureDocumentsPath } from "@/features/signatures/paths";

// SGN-02 (235) ב: "מסמכים ללא רשומה" sits in the settings list for owners, admins and managers by role, as the quotes of
// deleted customers (the select policy of signature_documents decides again on the page)
describe("documents without a record (SGN-02 (235) ב)", () => {
  const hrefs = (role: "owner" | "admin" | "manager" | "member" | "viewer") =>
    settingsGroups("org-1", settingsAccessFor({ role, canWrite: true, canDelete: false, priceLists: false, granted: [] })).flatMap((g) =>
      g.sections.map((s) => s.href),
    );

  it("is listed for owners, admins and managers only", () => {
    expect(detachedSignatureDocumentsPath("org-1")).toBe("/o/org-1/settings/deleted-customer-documents");
    for (const role of ["owner", "admin", "manager"] as const) expect(hrefs(role), role).toContain(detachedSignatureDocumentsPath("org-1"));
    for (const role of ["member", "viewer"] as const) expect(hrefs(role), role).not.toContain(detachedSignatureDocumentsPath("org-1"));
  });
});

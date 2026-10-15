import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ADMIN_NAV } from "@/features/platform/nav";

// The platform panel's menu reaches every page of src/app/admin (ADM-01 follow-up: the VAT rates page).
describe("platform admin menu", () => {
  it("links every top-level admin page once", () => {
    const dir = join(process.cwd(), "src/app/admin");
    const pages = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("[") && !entry.name.startsWith("("))
      .map((entry) => `/admin/${entry.name}`);
    const hrefs = ADMIN_NAV.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect([...hrefs].sort()).toEqual(["/admin", ...pages].sort());
  });

  it("names the VAT rates page in Hebrew", () => {
    expect(ADMIN_NAV.find((item) => item.href === "/admin/vat")?.label).toBe('שיעורי מע"מ');
  });
});

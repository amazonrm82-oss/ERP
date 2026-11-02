import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SUPPORT_CATEGORIES, SUPPORT_STATUSES, supportPagePath, validPagePath } from "@/features/support-requests/categories";
import { hasUnreadWhatsNew, LATEST_WHATS_NEW, WHATS_NEW } from "@/features/whats-new/entries";
import { migrationNames, migrationText } from "./helpers/migrations";

const migration = () => migrationText(migrationNames().find((name) => name.endsWith("_support_requests.sql"))!);
const listIn = (sql: string, constraint: string) => {
  const m = new RegExp(`${constraint} check \\((?:category|status) in \\(([^)]*)\\)\\)`).exec(sql);
  return (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/'/g, "")).sort();
};

describe("USR-12: support requests", () => {
  it("the category and status lists equal the database's", () => {
    expect(listIn(migration(), "support_requests_category_check")).toEqual(Object.keys(SUPPORT_CATEGORIES).sort());
    expect(listIn(migration(), "support_requests_status_check")).toEqual(Object.keys(SUPPORT_STATUSES).sort());
  });

  it("the page comes from this site only, as a path without its query", () => {
    expect(supportPagePath("https://crm.example/o/1/leads?q=דנה#top", "crm.example")).toBe("/o/1/leads");
    expect(supportPagePath("https://other.example/o/1/leads", "crm.example")).toBeNull();
    expect(supportPagePath("javascript:alert(1)", "crm.example")).toBeNull();
    expect(supportPagePath("not a url", "crm.example")).toBeNull();
    expect(supportPagePath(null, "crm.example")).toBeNull();
    expect(supportPagePath("https://crm.example/o/1", null)).toBeNull();
    expect(supportPagePath(`https://crm.example/${"a".repeat(400)}`, "crm.example")).toBeNull();
    expect(validPagePath("/o/1/leads")).toBe(true);
    expect(validPagePath("/o/1?x=1")).toBe(false);
    expect(validPagePath("o/1")).toBe(false);
    // L5: "//host" and "/\\host" are another site to a browser
    expect(validPagePath("//evil.example/x")).toBe(false);
    expect(validPagePath("/\\evil.example/x")).toBe(false);
    expect(supportPagePath("https://crm.example//evil.example/x", "crm.example")).toBeNull();
    expect(listIn(migration(), "support_requests_category_check").length).toBeGreaterThan(0);
  });
});

describe("USR-12: what's new", () => {
  it("entries are dated and kept newest first", () => {
    expect(WHATS_NEW.length).toBeGreaterThan(0);
    for (const entry of WHATS_NEW) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.title.trim()).not.toBe("");
      expect(entry.body.trim()).not.toBe("");
    }
    const dates = WHATS_NEW.map((entry) => entry.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(LATEST_WHATS_NEW).toBe(dates[0]);
  });

  it("shows the dot until the newest entry was seen", () => {
    expect(hasUnreadWhatsNew(null)).toBe(true);
    expect(hasUnreadWhatsNew("2020-01-01")).toBe(true);
    expect(hasUnreadWhatsNew(LATEST_WHATS_NEW)).toBe(false);
  });
});

describe("USR-12 review: who reaches support, and what the menu says", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("the support page lets the owner of a closed business in (M1)", () => {
    const page = read("src/app/o/[orgId]/support/page.tsx");
    expect(page).toContain("getOrgContextForOwner(orgId)");
    expect(page).not.toMatch(/getOrgContext\(orgId\)/);
  });

  it("the closed business's frame offers support and shows the banners (M1)", () => {
    const layout = read("src/app/o/[orgId]/layout.tsx");
    const closed = layout.slice(layout.indexOf("if (context.closed)"), layout.indexOf("const [notifications"));
    expect(closed).toContain("paths.support(org.id)");
    expect(closed).toContain("<SystemBanners");
  });

  it("the account button names the unread dot for screen readers (L8)", () => {
    const menu = read("src/features/shell/components/user-menu.tsx");
    const button = menu.slice(menu.indexOf("<button"), menu.indexOf("</button>"));
    expect(button).toContain('className="sr-only"> (יש חדש)');
  });
});

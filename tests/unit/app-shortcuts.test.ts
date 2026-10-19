import { existsSync } from "node:fs";

import { describe, expect, it } from "vitest";

import manifest from "@/app/manifest";
import { findShortcut, SHORTCUTS, shortcutOrg } from "@/features/shortcuts/shortcuts";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("installed app shortcuts (USR-08)", () => {
  it("the manifest has the owner's four, in order, each through /app/go", () => {
    const shortcuts = manifest().shortcuts ?? [];
    expect(shortcuts.map((s) => s.name)).toEqual(["ליד חדש", "לידים מחכים", "היום שלי", "יומן"]);
    expect(shortcuts.map((s) => s.url)).toEqual(["/app/go/new-lead", "/app/go/waiting-leads", "/app/go/my-day", "/app/go/calendar"]);
    expect(existsSync(new URL("../../src/app/app/go/[target]/route.ts", import.meta.url))).toBe(true);
  });

  it("each opens its screen in the business", () => {
    const paths = Object.fromEntries(SHORTCUTS.map((s) => [s.target, s.path(A)]));
    expect(paths["new-lead"]).toBe(`/o/${A}/leads/new`);
    expect(paths["waiting-leads"]).toBe(`/o/${A}/leads/waiting`);
    expect(paths["my-day"]).toBe(`/o/${A}`);
    expect(paths.calendar.startsWith(`/o/${A}/calendar`)).toBe(true);
    expect(findShortcut("delete-everything")).toBeNull();
  });

  it("opens the last business worked in while the person is still in it, else the only one, else the picker", () => {
    expect(shortcutOrg(B, [A, B])).toBe(B);
    // left that business, or a cookie from someone else's session on this device
    expect(shortcutOrg(B, [A])).toBe(A);
    expect(shortcutOrg(null, [A])).toBe(A);
    expect(shortcutOrg(null, [A, B])).toBeNull();
    expect(shortcutOrg("not-an-org", [A, B])).toBeNull();
    expect(shortcutOrg(A, [])).toBeNull();
  });
});

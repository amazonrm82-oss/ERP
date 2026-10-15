import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BUILT_MEMBER_PERMISSIONS,
  MEMBER_PERMISSION_KEYS,
  MEMBER_PERMISSIONS,
  canEditCatalog,
  canExportWith,
  canImportWith,
  canManageAutomations,
  hasPermission,
} from "@/features/permissions/keys";

const dir = path.resolve(__dirname, "../../supabase/migrations");
const migration = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_member_permissions.sql"))!), "utf8");

// PRM-01: the closed list of keys is the same in the app and in the database
describe("member permission keys", () => {
  it("match app.member_permission_keys() and the check constraint", () => {
    const fn = migration.match(/function app\.member_permission_keys\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/);
    const check = migration.match(/constraint member_permissions_known check \(\s*permissions <@ array\[([\s\S]*?)\]::text\[\]/);
    const keys = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(fn && keys(fn[1])).toEqual([...MEMBER_PERMISSION_KEYS].sort());
    expect(check && keys(check[1])).toEqual([...MEMBER_PERMISSION_KEYS].sort());
    expect(MEMBER_PERMISSIONS.map((p) => p.key).sort()).toEqual([...MEMBER_PERMISSION_KEYS].sort());
  });

  it("owners and admins hold everything; managers and members what was granted; viewers nothing", () => {
    for (const key of MEMBER_PERMISSION_KEYS) {
      expect(hasPermission("owner", [], key)).toBe(true);
      expect(hasPermission("admin", [], key)).toBe(true);
      expect(hasPermission("member", [], key)).toBe(false);
      expect(hasPermission("member", [key], key)).toBe(true);
      expect(hasPermission("manager", [key], key)).toBe(true);
      expect(hasPermission("viewer", [key], key)).toBe(false);
    }
  });

  it("export and import keep the team manager's role rule; catalog and automations are owner/admin or the grant", () => {
    expect(canExportWith("manager", [])).toBe(true);
    expect(canExportWith("member", [])).toBe(false);
    expect(canExportWith("member", ["export"])).toBe(true);
    expect(canExportWith("viewer", ["export"])).toBe(false);
    expect(canImportWith("manager", [])).toBe(true);
    expect(canImportWith("member", ["import"])).toBe(true);
    expect(canImportWith("member", ["export"])).toBe(false);
    expect(canEditCatalog("manager", [])).toBe(false);
    expect(canEditCatalog("manager", ["edit_catalog"])).toBe(true);
    expect(canManageAutomations("member", ["manage_automations"])).toBe(true);
    expect(canManageAutomations("admin", [])).toBe(true);
  });
});

describe("member permission screen texts", () => {
  it("warns next to the automations permission (owner, 15 October 2026)", () => {
    const automations = MEMBER_PERMISSIONS.find((p) => p.key === "manage_automations");
    expect(automations?.warning).toBe(
      "הרשאה זו נותנת גישה בפועל לכל הרשומות בעסק, גם לכאלה שהעובד לא רשאי לראות. לתת רק למי שסומכים עליו כמו על מנהל מערכת.",
    );
    expect(automations?.confirm).toBe(true);
  });

  it("the built keys match app.member_permission_built_keys()", () => {
    const answer = readFileSync(path.join(dir, readdirSync(dir).find((f) => f.endsWith("_automation_permission_answer.sql"))!), "utf8");
    const fn = answer.match(/function app\.member_permission_built_keys\(\)[\s\S]*?array\[([\s\S]*?)\]::text\[\]/);
    expect(fn && [...fn[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...BUILT_MEMBER_PERMISSIONS].sort());
  });
});

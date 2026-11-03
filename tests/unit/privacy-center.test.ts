import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isPrivacyClass, PRIVACY_CLASSES, privacyClassFromForm } from "@/features/privacy-center/classes";
import { BUILT_IN_PERSONAL_FIELDS } from "@/features/privacy-center/personal-fields";
import { activeRoleCounts, markedFields, personalDataGrants, withoutSecondStep } from "@/features/privacy-center/summary";

const migrations = join(__dirname, "../../supabase/migrations");

describe("privacy center (PRK-01)", () => {
  it("the field marks mirror the database constraint", () => {
    const file = readdirSync(migrations).find((name) => name.endsWith("_field_privacy_class.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(migrations, file!), "utf8");
    const match = sql.match(/privacy_class in \(([^)]*)\)/);
    expect(match).not.toBeNull();
    const values = match![1].split(",").map((v) => v.trim().replace(/'/g, ""));
    expect(values).toEqual([...PRIVACY_CLASSES]);
  });

  it("reads the form's choice; anything else is no mark", () => {
    expect(privacyClassFromForm("sensitive")).toBe("sensitive");
    expect(privacyClassFromForm("personal")).toBe("personal");
    expect(privacyClassFromForm("")).toBeNull();
    expect(privacyClassFromForm("secret")).toBeNull();
    expect(privacyClassFromForm(null)).toBeNull();
    expect(isPrivacyClass(1)).toBe(false);
  });

  it("lists built-in personal fields for every record type", () => {
    for (const type of ["lead", "contact", "company", "deal"] as const) {
      expect(BUILT_IN_PERSONAL_FIELDS[type].length).toBeGreaterThan(0);
    }
  });

  it("counts active members by role, in role order", () => {
    expect(
      activeRoleCounts([
        { role: "member", status: "active" },
        { role: "owner", status: "active" },
        { role: "member", status: "active" },
        { role: "admin", status: "suspended" },
      ]),
    ).toEqual([
      { role: "owner", count: 1 },
      { role: "member", count: 2 },
    ]);
  });

  it("lists only grants that touch personal information, held by active managers and members", () => {
    const members = [
      { userId: "a", name: "דנה", status: "active", role: "member" as const },
      { userId: "b", name: "יוסי", status: "suspended", role: "member" as const },
      { userId: "c", name: "רון", status: "active", role: "manager" as const },
    ];
    const grants = new Map([
      ["a", ["export", "edit_catalog"]],
      ["b", ["export"]],
      ["c", ["import"]],
    ]);
    const rows = personalDataGrants(grants, members);
    expect(rows.map((r) => [r.key, r.names])).toEqual([
      ["export", ["דנה"]],
      ["import", ["רון"]],
    ]);
  });

  it("shows marked fields, sensitive first", () => {
    expect(
      markedFields([
        { label: "תקציב", privacyClass: null, isActive: true },
        { label: "תחביב", privacyClass: "personal", isActive: true },
        { label: "מצב רפואי", privacyClass: "sensitive", isActive: false },
      ]),
    ).toEqual([
      { label: "מצב רפואי", privacyClass: "sensitive", isActive: false },
      { label: "תחביב", privacyClass: "personal", isActive: true },
    ]);
  });

  it("counts active members without a second step", () => {
    expect(withoutSecondStep([{ userId: "a", status: "active" }, { userId: "b", status: "active" }, { userId: "c", status: "suspended" }], ["a"])).toBe(1);
  });
});

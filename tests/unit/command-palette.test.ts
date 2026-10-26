import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_MODULES } from "@/features/modules/modules";
import { commandRank, matchCommands } from "@/features/search/command-match";
import { buildCommands, type CommandAccess } from "@/features/search/commands";
import { settingsAccessFor } from "@/features/settings/sections";
import { DEFAULT_TERMS, resolveTerms } from "@/features/terminology/terms";
import { paths } from "@/lib/paths";

const ORG = "11111111-1111-4111-8111-111111111111";

const access = (role: "owner" | "admin" | "manager" | "member" | "viewer", canWrite = role !== "viewer", granted: string[] = []): CommandAccess => ({
  canWrite,
  settings: settingsAccessFor({ role, canWrite, canDelete: canWrite && ["owner", "admin", "manager"].includes(role), priceLists: false, granted }),
});

const labels = (list: { label: string }[]) => list.map((c) => c.label);

describe("command palette (REC-09)", () => {
  const ownerCommands = buildCommands(ORG, DEFAULT_TERMS, DEFAULT_MODULES, access("owner"));

  it("offers creating each record type, the main screens and the settings sections", () => {
    expect(labels(ownerCommands.filter((c) => c.group === "create"))).toEqual(["ליד חדש", "איש קשר חדש", "חברה חדשה", "עסקה חדשה", "משימה חדשה"]);
    const nav = labels(ownerCommands.filter((c) => c.group === "navigate"));
    expect(nav).toEqual(expect.arrayContaining(["בית", "לידים", "אנשי קשר", "עסקאות", "משימות", "יומן", "דוחות", "הגדרות", "התראות"]));
    const settings = labels(ownerCommands.filter((c) => c.group === "settings"));
    expect(settings).toEqual(expect.arrayContaining(["החשבון שלי", "פרטי העסק", "אוטומציות", "יומן ביקורת", "מונחים"]));
    expect(ownerCommands.find((c) => c.label === "ליד חדש")?.href).toBe(paths.leadNew(ORG));
    // keys are unique (React keys and the listbox ids)
    expect(new Set(ownerCommands.map((c) => c.key)).size).toBe(ownerCommands.length);
  });

  it("finds an action or a place by its words, best match first", () => {
    expect(labels(matchCommands(ownerCommands, "ליד חדש"))[0]).toBe("ליד חדש");
    expect(labels(matchCommands(ownerCommands, "הגדרות"))[0]).toBe("הגדרות");
    expect(labels(matchCommands(ownerCommands, "חדש"))).toEqual(expect.arrayContaining(["ליד חדש", "משימה חדשה"]));
    expect(labels(matchCommands(ownerCommands, "יומן"))).toEqual(["יומן", "יומן ביקורת"]);
    // a word of a settings section's description finds it
    expect(labels(matchCommands(ownerCommands, "סיסמה"))).toEqual(["החשבון שלי"]);
    // final letters, niqqud and one attached letter do not matter
    expect(labels(matchCommands(ownerCommands, "להגדרות"))[0]).toBe("הגדרות");
    expect(labels(matchCommands(ownerCommands, "משימות"))[0]).toBe("משימות");
    expect(labels(matchCommands(ownerCommands, "תגיוֹת"))).toContain("תגיות");
    // every word must match
    expect(matchCommands(ownerCommands, "ליד ביקורת")).toEqual([]);
    expect(matchCommands(ownerCommands, "zzzz")).toEqual([]);
    expect(matchCommands(ownerCommands, "   ")).toEqual([]);
  });

  it("shows at most six, and ranks the label above keywords", () => {
    expect(matchCommands(ownerCommands, "הגדרות").length).toBe(6);
    const leads = ownerCommands.find((c) => c.key === "nav:leads")!;
    expect(commandRank(leads, "לידים")).toBe(0);
    expect(commandRank(leads, "מעבר")).toBe(3);
    expect(commandRank(leads, "ביקורת")).toBeNull();
  });

  it("a viewer creates nothing and sees only the settings everyone sees", () => {
    const viewer = buildCommands(ORG, DEFAULT_TERMS, DEFAULT_MODULES, access("viewer"));
    expect(viewer.some((c) => c.group === "create")).toBe(false);
    expect(matchCommands(viewer, "ליד חדש").some((c) => c.group === "create")).toBe(false);
    const settings = labels(viewer.filter((c) => c.group === "settings"));
    expect(settings).not.toContain("אוטומציות");
    expect(settings).not.toContain("יומן ביקורת");
    expect(settings).not.toContain("סל מחזור");
    expect(settings).toContain("החשבון שלי");
  });

  it("a member with the automations permission (PRM-01) is offered the automations", () => {
    const plain = buildCommands(ORG, DEFAULT_TERMS, DEFAULT_MODULES, access("member"));
    const granted = buildCommands(ORG, DEFAULT_TERMS, DEFAULT_MODULES, access("member", true, ["manage_automations"]));
    expect(labels(matchCommands(plain, "אוטומציות"))).toEqual([]);
    expect(labels(matchCommands(granted, "אוטומציות"))).toEqual(["אוטומציות"]);
  });

  it("a switched-off module (LEAD-08) is not offered; orders only with the module and the plan", () => {
    const off = buildCommands(ORG, DEFAULT_TERMS, { ...DEFAULT_MODULES, leads: false, companies: false }, access("owner"));
    expect(off.some((c) => c.key === "create:lead" || c.key === "nav:leads")).toBe(false);
    expect(off.some((c) => c.key === "create:company" || c.key === "nav:companies")).toBe(false);
    expect(ownerCommands.some((c) => c.key === "nav:orders")).toBe(false);
    const withOrders = buildCommands(ORG, DEFAULT_TERMS, { ...DEFAULT_MODULES, orders: true }, access("owner"));
    expect(labels(matchCommands(withOrders, "הזמנות"))[0]).toBe("הזמנות");
  });

  it("speaks the business's words (FLD-10), and today's word still finds them", () => {
    const terms = resolveTerms({ contact: "customer", lead: "inquiry", deal: null });
    const renamed = buildCommands(ORG, terms, DEFAULT_MODULES, access("owner"));
    expect(labels(renamed.filter((c) => c.group === "create"))).toContain("פנייה חדשה");
    expect(labels(renamed)).not.toContain("ליד חדש");
    expect(labels(matchCommands(renamed, "פנייה חדשה"))[0]).toBe("פנייה חדשה");
    expect(labels(matchCommands(renamed, "ליד חדש"))).toContain("פנייה חדשה");
    expect(labels(matchCommands(renamed, "לקוחות"))[0]).toBe("לקוחות");
  });

  it("the settings page, its side list and the palette share one access rule", () => {
    for (const file of ["src/app/o/[orgId]/settings/page.tsx", "src/app/o/[orgId]/settings/layout.tsx", "src/features/search/actions.ts"]) {
      expect(readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")).toContain("settingsAccessFor(");
    }
    // the browser palette never pulls the server list builder
    const palette = readFileSync(new URL("../../src/features/search/components/global-search.tsx", import.meta.url), "utf8");
    expect(palette).not.toMatch(/from "\.\.\/commands"/);
  });
});

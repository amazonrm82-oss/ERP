import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { contactDealsWithRoles } from "@/features/deal-contacts/contact-deals";
import { dealContactExclude } from "@/features/deal-contacts/options";
import {
  DEAL_CONTACT_ROLE_KEYS,
  DEAL_CONTACT_ROLES,
  dealContactRoleLabel,
  isDealContactRole,
  linkRole,
  roleChoices,
  type DealContactRoleOption,
} from "@/features/deal-contacts/roles";
import { addDealContactSchema, dealContactRoleArg } from "@/features/deal-contacts/schema";
import type { RelatedDeal } from "@/features/deals/queries";

const ID = "11111111-1111-4111-8111-111111111111";

const deal = (id: string): RelatedDeal => ({ id, name: `עסקה ${id}`, amountAgorot: 0, stageName: null, status: "open" });

// CON-03: four fixed roles, stored as keys, mirrored by a check constraint
describe("roles of contacts in a deal (CON-03)", () => {
  it("the app's list is the list of the database constraint", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    // the latest migration that sets the constraint wins (file names sort in apply order)
    const sql = readdirSync(dir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .filter((text) => text.includes("add constraint deal_contacts_role_check"))
      .at(-1);
    expect(sql, "a migration adds deal_contacts_role_check").toBeDefined();
    const list = /deal_contacts_role_check\s+check \(role is null or role in \(([^)]*)\)\)/.exec(sql ?? "")?.[1] ?? "";
    const keys = [...list.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect(keys).toEqual([...DEAL_CONTACT_ROLE_KEYS]);
  });

  it("shows Hebrew labels and nothing for no role or an unknown value", () => {
    expect(dealContactRoleLabel("decision_maker")).toBe("מקבל החלטה");
    expect(dealContactRoleLabel("finance")).toBe("איש כספים");
    expect(dealContactRoleLabel(null)).toBeNull();
    expect(dealContactRoleLabel("boss")).toBeNull();
    expect(isDealContactRole("user")).toBe(true);
    expect(isDealContactRole("מחליט")).toBe(false);
  });

  it("accepts a role id of the list or none, nothing else (the database checks the id)", () => {
    expect(dealContactRoleArg.parse(ID)).toBe(ID);
    expect(dealContactRoleArg.parse("")).toBeNull();
    expect(dealContactRoleArg.parse(null)).toBeNull();
    expect(dealContactRoleArg.safeParse("influencer").success).toBe(false);
    expect(dealContactRoleArg.safeParse(7).success).toBe(false);
    expect(addDealContactSchema.parse({ contact_id: ID, role_id: null })).toEqual({ contact_id: ID, role_id: null });
    expect(addDealContactSchema.parse({ contact_id: ID, role_id: "" })).toEqual({ contact_id: ID, role_id: null });
    expect(addDealContactSchema.safeParse({ contact_id: "", role_id: ID }).success).toBe(false);
  });

  it("lists the main deals first, then the deals the contact takes part in, each once, with the role", () => {
    const rows = contactDealsWithRoles(
      [deal("a"), deal("b")],
      [deal("b"), deal("c"), deal("d")],
      [
        { dealId: "b", roleLabel: "איש כספים" },
        { dealId: "c", roleLabel: "מקבל החלטה" },
        { dealId: "d", roleLabel: null },
      ],
    );
    expect(rows.map((row) => [row.id, row.roleLabel])).toEqual([
      ["a", null],
      ["b", "תפקיד: איש כספים"],
      ["c", "תפקיד: מקבל החלטה"],
      ["d", "איש קשר בעסקה"],
    ]);
  });

  it("leaves out of the add search the deal's main contact and the contacts linked already, each once", () => {
    expect(dealContactExclude(["b"], "c")).toEqual(["b", "c"]);
    expect(dealContactExclude([], null)).toEqual([]);
    expect(dealContactExclude(["a", "b", "a"], "b")).toEqual(["a", "b"]);
  });
});

// CON-03 follow-up (owner, 14 October 2026): the roles are a managed list per business; the four are its defaults
describe("the business's list of roles (CON-03 follow-up)", () => {
  const roles: DealContactRoleOption[] = [
    { id: "r1", name: "מחליט סופי", key: "decision_maker", isActive: true },
    { id: "r2", name: "משפיע", key: "influencer", isActive: false },
    { id: "r3", name: "יועץ משפטי", key: null, isActive: true },
  ];

  it("the database seeds the four defaults with their old codes, in this order", () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_deal_contact_roles_list.sql"));
    const sql = readFileSync(join(dir, file ?? ""), "utf8");
    const seed = /function app\.seed_deal_contact_roles[\s\S]*?\$\$;/.exec(sql)?.[0] ?? "";
    const rows = [...seed.matchAll(/\('([^']+)', '([a-z_]+)', (\d+)\)/g)].map((m) => ({ label: m[1], key: m[2], pos: Number(m[3]) }));
    expect(rows.map(({ key, label }) => ({ key, label }))).toEqual(DEAL_CONTACT_ROLES.map(({ key, label }) => ({ key, label })));
    expect(rows.map((row) => row.pos)).toEqual([0, 1, 2, 3]);
    // the cap of the database is the app's
    expect(sql).toContain(") >= 20 then");
  });

  it("a link shows its role by id, an old link by its code's role (current name), else none", () => {
    expect(linkRole({ roleId: "r3", role: null }, roles)?.name).toBe("יועץ משפטי");
    expect(linkRole({ roleId: null, role: "decision_maker" }, roles)?.name).toBe("מחליט סופי");
    // the id wins over an old code
    expect(linkRole({ roleId: "r3", role: "decision_maker" }, roles)?.id).toBe("r3");
    // a hidden role still shows on the links that have it
    expect(linkRole({ roleId: null, role: "influencer" }, roles)?.id).toBe("r2");
    // the default was deleted, or the id is gone: no role
    expect(linkRole({ roleId: null, role: "finance" }, roles)).toBeNull();
    expect(linkRole({ roleId: "gone", role: null }, roles)).toBeNull();
    expect(linkRole({ roleId: null, role: null }, roles)).toBeNull();
  });

  it("offers the active roles, plus the link's own hidden one", () => {
    expect(roleChoices(roles, null).map((role) => role.id)).toEqual(["r1", "r3"]);
    expect(roleChoices(roles, roles[1]).map((role) => role.id)).toEqual(["r1", "r2", "r3"]);
  });
});

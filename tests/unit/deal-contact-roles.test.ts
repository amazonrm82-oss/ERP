import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { contactDealsWithRoles } from "@/features/deal-contacts/contact-deals";
import { addableDealContacts } from "@/features/deal-contacts/options";
import { DEAL_CONTACT_ROLE_KEYS, dealContactRoleLabel, isDealContactRole } from "@/features/deal-contacts/roles";
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

  it("accepts a role from the list or none, nothing else", () => {
    expect(dealContactRoleArg.parse("influencer")).toBe("influencer");
    expect(dealContactRoleArg.parse("")).toBeNull();
    expect(dealContactRoleArg.parse(null)).toBeNull();
    expect(dealContactRoleArg.safeParse("boss").success).toBe(false);
    expect(dealContactRoleArg.safeParse(7).success).toBe(false);
    expect(addDealContactSchema.parse({ contact_id: ID, role: null })).toEqual({ contact_id: ID, role: null });
    expect(addDealContactSchema.safeParse({ contact_id: "", role: "user" }).success).toBe(false);
  });

  it("lists the main deals first, then the deals the contact takes part in, each once, with the role", () => {
    const rows = contactDealsWithRoles(
      [deal("a"), deal("b")],
      [deal("b"), deal("c"), deal("d")],
      [
        { dealId: "b", role: "finance" },
        { dealId: "c", role: "decision_maker" },
        { dealId: "d", role: null },
      ],
    );
    expect(rows.map((row) => [row.id, row.roleLabel])).toEqual([
      ["a", null],
      ["b", "תפקיד: איש כספים"],
      ["c", "תפקיד: מקבל החלטה"],
      ["d", "איש קשר בעסקה"],
    ]);
  });

  it("offers to add only contacts that are neither the deal's main contact nor linked already", () => {
    const options = ["a", "b", "c", "d"].map((id) => ({ id, name: id }));
    expect(addableDealContacts(options, ["b"], "c").map((option) => option.id)).toEqual(["a", "d"]);
    expect(addableDealContacts(options, [], null).map((option) => option.id)).toEqual(["a", "b", "c", "d"]);
    expect(addableDealContacts(options, ["a", "b", "c", "d"], null)).toEqual([]);
  });
});

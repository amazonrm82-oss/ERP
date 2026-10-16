import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type Usage = { plan_key: string; plan_name: string; status: string; usage: Array<{ key: string; limit: number | null; used: number }> };

const usageOf = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ u: Usage }>("select public.org_plan_usage($1) as u", [org])).rows[0].u);

describe("plan and usage for the 'חבילה ושימוש' page (FXU-04)", () => {
  let owner: { id: string };
  let member: { id: string };
  let outsider: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("usage-owner");
    outsider = await createUser("usage-outsider");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member");
    await insertLead(owner.id, org, { full_name: "ליד 1" });
    await insertLead(owner.id, org, { full_name: "ליד 2" });
  });

  it("counts the whole business against each effective limit", async () => {
    const u = await usageOf(owner.id, org);
    expect(u.plan_name.length).toBeGreaterThan(0);
    const by = Object.fromEntries(u.usage.map((row) => [row.key, row]));
    expect(by.max_users.used).toBe(2);
    expect(Number(by.max_records.used)).toBeGreaterThanOrEqual(2);
    expect(by.max_pipelines.used).toBe(1);
    // PRM-02: view seats are listed while the plan has them (the trial does)
    expect(Object.keys(by).sort()).toEqual(["max_active_automations", "max_forms", "max_pipelines", "max_price_lists", "max_products", "max_records", "max_users", "storage_gb", "view_seats"]);
    expect(by.view_seats).toEqual({ key: "view_seats", limit: 2, used: 0 });
  });

  it("a member sees the same numbers, even of records they may not see", async () => {
    expect(await usageOf(member.id, org)).toEqual(await usageOf(owner.id, org));
  });

  it("follows a per-business override of the plan", async () => {
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = '{\"max_pipelines\": 7}' where organization_id = $1", [org]));
    const u = await usageOf(owner.id, org);
    expect(u.usage.find((row) => row.key === "max_pipelines")?.limit).toBe(7);
  });

  it("answers members only", async () => {
    expect((await pgError(usageOf(outsider.id, org))).code).toBe("42501");
    const anonGrant = await asAdmin(
      async (q) => (await q<{ ok: boolean }>("select has_function_privilege('anon', 'public.org_plan_usage(uuid)', 'execute') as ok")).rows[0].ok,
    );
    expect(anonGrant).toBe(false);
  });
});

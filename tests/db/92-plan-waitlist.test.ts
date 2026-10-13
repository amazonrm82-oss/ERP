import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const makeStaff = (userId: string, role: string) =>
  asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));

// "עדכנו אותי כשזה זמין" on a coming-soon plan (owner's pricing, 13 October 2026).
describe("plan waitlist", () => {
  let owner: { id: string };
  let member: { id: string };
  let outsider: { id: string };
  let org: string;
  let otherOrg: string;

  beforeAll(async () => {
    owner = await createUser("wl-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "wl-member");
    outsider = await createUser("wl-outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  const ask = (userId: string, orgId: string, plan: string) =>
    asUser(userId, (q) => q("insert into public.plan_waitlist (organization_id, plan_key) values ($1, $2) returning user_id", [orgId, plan]));

  it("records the business and the person, once, for a coming-soon plan only", async () => {
    const row = await ask(member.id, org, "business");
    expect(row.rows[0].user_id).toBe(member.id);
    expect((await pgError(ask(member.id, org, "business"))).code).toBe("23505");
    for (const plan of ["pro", "personal", "free"]) {
      expect((await pgError(ask(member.id, org, plan))).code, plan).toBe("42501");
    }
  });

  it("never for another business", async () => {
    expect((await pgError(ask(outsider.id, org, "business"))).code).toBe("42501");
    await ask(outsider.id, otherOrg, "business");
    expect(await asUser(outsider.id, (q) => count(q, "select 1 from public.plan_waitlist where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(owner.id, (q) => count(q, "select 1 from public.plan_waitlist where organization_id = $1", [otherOrg]))).toBe(0);
  });

  it("anon has no access", async () => {
    expect((await pgError(asAnon((q) => q("select 1 from public.plan_waitlist")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.platform_plan_waitlist()")))).code).toBe("42501");
  });

  it("the platform panel sees the count per plan; customers do not", async () => {
    const staff = await createUser("wl-staff");
    await makeStaff(staff.id, "readonly");
    const counts = await asMfaUser(staff.id, async (q) => (await q<{ r: Record<string, number> }>("select public.platform_plan_waitlist() as r")).rows[0].r);
    const total = await asAdmin((q) => count(q, "select 1 from public.plan_waitlist where plan_key = 'business'"));
    expect(counts.business).toBe(total);
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_plan_waitlist()")))).code).toBe("42501");
  });

  it("goes with the membership", async () => {
    const leaving = await addMember(org, owner.id, "member", "wl-leaving");
    await ask(leaving.id, org, "business");
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaving.id]));
    expect(await asAdmin((q) => count(q, "select 1 from public.plan_waitlist where user_id = $1", [leaving.id]))).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser } from "./helpers";

afterAll(closePool);

type Ctx = {
  org: { id: string; name: string; status: string } | null;
  membership: { role: string; is_available: boolean } | null;
  subscription: { status: string; plan_key: string; plan_name: string | null; trial_ends_at: string | null } | null;
  full_name: string | null;
  agreement_version: string | null;
};

describe("org_context: a page's organization context in one call", () => {
  let owner: { id: string }, member: { id: string }, outsider: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("ctx-owner");
    org = await createOrg(owner.id, "עסק הקשר");
    member = await addMember(org, owner.id, "member", "ctx-member");
    outsider = await createUser("ctx-outsider");
    await createOrg(outsider.id);
  });

  const context = (userId: string, mfa = false): Promise<Ctx> =>
    (mfa ? asMfaUser : asUser)(userId, async (q) => (await q<{ c: Ctx }>("select public.org_context($1) as c", [org])).rows[0].c);

  it("a member gets the organization, their role, the plan's name and their name", async () => {
    const ctx = await context(member.id);
    expect(ctx.org).toMatchObject({ id: org, name: "עסק הקשר" });
    expect(ctx.membership).toEqual({ role: "member", is_available: true });
    expect(ctx.subscription?.plan_name).toBeTruthy();
    expect(ctx.subscription?.status).toBe("trialing");
    expect(ctx.full_name).toBe("ctx-member");
    expect(ctx.agreement_version).toBeNull();
  });

  it("matches the separate queries it replaces", async () => {
    const separate = await asUser(member.id, async (q) => ({
      org: (await q("select id, name, status from public.organizations where id = $1 and deleted_at is null", [org])).rows[0],
      plan: (await q("select p.name_he from public.subscriptions s join public.plans p on p.key = s.plan_key where s.organization_id = $1", [org])).rows[0]
        .name_he,
    }));
    const ctx = await context(member.id);
    expect(ctx.org).toEqual(separate.org);
    expect(ctx.subscription?.plan_name).toBe(separate.plan);
  });

  it("someone else's organization: nothing", async () => {
    const ctx = await context(outsider.id);
    expect(ctx.org).toBeNull();
    expect(ctx.membership).toBeNull();
    expect(ctx.subscription).toBeNull();
  });

  it("an organization that requires two-step verification: nothing until the session has passed it", async () => {
    await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
    try {
      const blocked = await context(member.id);
      expect(blocked.org).toBeNull();
      expect(blocked.membership).toBeNull();
      const passed = await context(member.id, true);
      expect(passed.membership?.role).toBe("member");
    } finally {
      await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
    }
  });

  it("a removed member: the organization is hidden too", async () => {
    const gone = await addMember(org, owner.id, "member", "ctx-gone");
    await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, gone.id]));
    const ctx = await context(gone.id);
    expect(ctx.membership).toBeNull();
    expect(ctx.org).toBeNull();
  });
});

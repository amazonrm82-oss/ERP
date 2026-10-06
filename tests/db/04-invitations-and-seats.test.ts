import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const invite = (inviterId: string, org: string, email: string, role = "member") =>
  asUser(inviterId, async (q) =>
    (await q<{ t: string }>("select public.create_invitation($1, $2, $3) as t", [org, email, role])).rows[0].t,
  );

const accept = (userId: string, token: string) => asUser(userId, (q) => q("select public.accept_invitation($1)", [token]));

describe("invitations", () => {
  let owner: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
  });

  it("a new organization starts as a 14-day Pro trial with its default setup", async () => {
    const state = await asUser(owner.id, async (q) => {
      const sub = (await q("select plan_key, status, trial_ends_at from public.subscriptions where organization_id = $1", [org])).rows[0];
      const role = (await q("select role, seat_type from public.memberships where organization_id = $1", [org])).rows[0];
      return {
        sub,
        role,
        pipelines: await count(q, "select 1 from public.pipelines where organization_id = $1", [org]),
        stages: await count(q, "select 1 from public.stages where organization_id = $1", [org]),
        statuses: await count(q, "select 1 from public.lead_statuses where organization_id = $1", [org]),
        sources: await count(q, "select 1 from public.lead_sources where organization_id = $1", [org]),
      };
    });
    expect(state.sub.plan_key).toBe("pro");
    expect(state.sub.status).toBe("trialing");
    const days = (new Date(state.sub.trial_ends_at).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    expect(state.role).toEqual({ role: "owner", seat_type: "full" });
    expect(state.pipelines).toBe(1);
    expect(state.stages).toBe(6);
    expect(state.statuses).toBe(7);
    expect(state.sources).toBe(7);
  });

  it("only the token's hash is stored", async () => {
    const token = await invite(owner.id, org, "hash-check@example.test");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stored = await asAdmin(async (q) =>
      (await q<{ token_hash: string }>("select token_hash from public.invitations where email = 'hash-check@example.test'")).rows[0].token_hash,
    );
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
    expect(stored).not.toBe(token);
  });

  it("only admins invite, and only the owner invites admins", async () => {
    const member = await addMember(org, owner.id, "member");
    const admin = await addMember(org, owner.id, "admin");
    expect((await pgError(invite(member.id, org, "a@example.test"))).code).toBe("42501");
    expect((await pgError(invite(admin.id, org, "b@example.test", "admin"))).code).toBe("42501");
    expect((await pgError(invite(owner.id, org, "c@example.test", "owner"))).code).toBe("22023");
    expect((await pgError(invite(owner.id, org, "not-an-email"))).code).toBe("22023");
    expect((await pgError(invite(owner.id, org, member.email))).code).toBe("23505");
    await invite(admin.id, org, "d@example.test", "member");
  });

  it("an invitation works once, for the invited address only", async () => {
    const invited = await createUser("invited");
    const stranger = await createUser("stranger");
    const token = await invite(owner.id, org, invited.email);

    expect((await pgError(accept(stranger.id, token))).code).toBe("42501");
    expect((await pgError(accept(invited.id, "0".repeat(64)))).code).toBe("P0002");

    await accept(invited.id, token);
    await asUser(invited.id, async (q) => {
      expect(await count(q, "select 1 from public.organizations where id = $1", [org])).toBe(1);
    });
    expect((await pgError(accept(invited.id, token))).code).toBe("P0002");
  });

  it("expired and replaced invitations are dead", async () => {
    const user = await createUser("late");
    const first = await invite(owner.id, org, user.email);
    const second = await invite(owner.id, org, user.email);
    // the second invitation revoked the first
    expect((await pgError(accept(user.id, first))).code).toBe("P0002");

    await asAdmin((q) => q("update public.invitations set expires_at = now() - interval '1 minute' where email = $1 and revoked_at is null", [user.email]));
    expect((await pgError(accept(user.id, second))).code).toBe("P0002");
  });

  it("an admin can revoke a pending invitation but cannot rewrite it", async () => {
    const user = await createUser("revoked");
    const token = await invite(owner.id, org, user.email);
    const rewrite = await pgError(
      asUser(owner.id, (q) => q("update public.invitations set role = 'admin' where email = $1", [user.email])),
    );
    expect(rewrite.code).toBe("42501");
    await asUser(owner.id, (q) => q("update public.invitations set revoked_at = now() where email = $1", [user.email]));
    expect((await pgError(accept(user.id, token))).code).toBe("P0002");
  });
});

describe("seats and plan user limits", () => {
  it("purchased seats cap the number of full users", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    await asAdmin((q) => q("update public.subscriptions set status = 'active', seats = 2 where organization_id = $1", [org]));

    await addMember(org, owner.id, "member", "second");
    const third = await createUser("third");
    const token = await invite(owner.id, org, third.email);
    const err = await pgError(accept(third.id, token));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("limit:seats");

    // a view-only seat is free on this plan and does not count
    await addMember(org, owner.id, "viewer");

    // buying a seat lets the third user in
    await asAdmin((q) => q("update public.subscriptions set seats = 3 where organization_id = $1", [org]));
    await accept(third.id, token);

    // suspending someone frees their seat; re-activating needs a free one
    const fourth = await createUser("fourth");
    const token4 = await invite(owner.id, org, fourth.email);
    expect((await pgError(accept(fourth.id, token4))).hint).toBe("limit:seats");
    await asUser(owner.id, (q) =>
      q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, third.id]),
    );
    await accept(fourth.id, token4);
    const reactivate = await pgError(
      asUser(owner.id, (q) =>
        q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, third.id]),
      ),
    );
    expect(reactivate.hint).toBe("limit:seats");
  });

  it("the free plan allows two users and no view-only seats", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    await asAdmin((q) =>
      q("update public.subscriptions set plan_key = 'free', status = 'active', seats = null where organization_id = $1", [org]),
    );

    await addMember(org, owner.id, "member", "second");
    const third = await createUser("third");
    const token = await invite(owner.id, org, third.email);
    const err = await pgError(accept(third.id, token));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("limit:max_users");

    const viewer = await pgError(invite(owner.id, org, "viewer@example.test", "viewer"));
    expect(viewer.code).toBe("P0001");
    expect(viewer.hint).toBe("feature:view_seats");
  });

  it("platform staff can override a limit for one organization", async () => {
    const owner = await createUser("owner");
    const org = await createOrg(owner.id);
    await asAdmin((q) =>
      q(
        `update public.subscriptions
            set plan_key = 'free', status = 'active', limit_overrides = '{"max_users": 3}', feature_overrides = '{"view_seats": true}'
          where organization_id = $1`,
        [org],
      ),
    );
    await addMember(org, owner.id, "member", "second");
    await addMember(org, owner.id, "member", "third");
    await addMember(org, owner.id, "viewer");
    const fourth = await createUser("fourth");
    const token = await invite(owner.id, org, fourth.email);
    expect((await pgError(accept(fourth.id, token))).hint).toBe("limit:max_users");
  });

  it("a user cannot own more than five organizations", async () => {
    const owner = await createUser("serial");
    for (let i = 0; i < 5; i++) await createOrg(owner.id, `עסק ${i}`);
    const err = await pgError(createOrg(owner.id, "עסק שישי"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("limit:owned_organizations");
  });
});

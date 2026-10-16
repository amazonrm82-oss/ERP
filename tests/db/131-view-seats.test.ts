import { afterAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Usage = { usage: Array<{ key: string; limit: number | null; used: number }> };

// PRM-02: view seats are free up to view_seats_per_paid_seat for every active paid (full) seat (owner's pricing of
// 13 October 2026: 0 / 0 / 1 / 1); the database refuses an active view seat over that.
describe("view seats per paid seat (PRM-02)", () => {
  const onPlan = (org: string, plan: string, overrides = "{}") =>
    asAdmin((q) => q("update public.subscriptions set plan_key = $2, status = 'active', seats = null, limit_overrides = $3::jsonb where organization_id = $1", [org, plan, overrides]));
  const invite = (owner: U, org: string, email: string, role = "viewer") =>
    asUser(owner.id, async (q) => (await q<{ t: string }>("select public.create_invitation($1, $2, $3) as t", [org, email, role])).rows[0].t);
  const accept = (user: U, token: string) => asUser(user.id, (q) => q("select public.accept_invitation($1)", [token]));
  const viewSeats = (user: U, org: string) =>
    asUser(user.id, async (q) => (await q<{ u: Usage }>("select public.org_plan_usage($1) as u", [org])).rows[0].u.usage.find((row) => row.key === "view_seats"));
  const membership = (org: string, user: U) =>
    asAdmin(async (q) => (await q<{ role: string; seat_type: string; status: string }>("select role, seat_type, status from public.memberships where organization_id = $1 and user_id = $2", [org, user.id])).rows[0]);

  it("one view seat for every paid seat: a viewer over it is not let in, and a new paid seat makes room", async () => {
    const owner = await createUser("vs-owner");
    const org = await createOrg(owner.id, "עסק מושבי צפייה");
    await onPlan(org, "pro");
    await addMember(org, owner.id, "viewer", "vs-viewer-1");
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 1, used: 1 });

    // the second viewer's invitation is sent, but the database refuses the seat when it is accepted
    const second = await createUser("vs-viewer-2");
    const token = await invite(owner, org, second.email);
    const refused = await pgError(accept(second, token));
    expect(refused.code).toBe("P0001");
    expect(refused.hint).toBe("limit:view_seats_per_paid_seat");

    // a second paid seat: room for one more viewer
    await addMember(org, owner.id, "member", "vs-member");
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 2, used: 1 });
    await accept(second, await invite(owner, org, second.email));
    expect(await membership(org, second)).toMatchObject({ role: "viewer", seat_type: "view", status: "active" });
  });

  it("a member made a viewer, and a suspended viewer brought back, need a free view seat; a suspended one does not count", async () => {
    const owner = await createUser("vs2-owner");
    const org = await createOrg(owner.id, "עסק תפקידים");
    await onPlan(org, "pro");
    const member = await addMember(org, owner.id, "member", "vs2-member");
    const viewer = await addMember(org, owner.id, "viewer", "vs2-viewer");
    const makeViewer = () =>
      asUser(owner.id, (q) => q("update public.memberships set role = 'viewer', seat_type = 'view' where organization_id = $1 and user_id = $2", [org, member.id]));
    const setStatus = (user: U, status: string) =>
      asUser(owner.id, (q) => q("update public.memberships set status = $3 where organization_id = $1 and user_id = $2", [org, user.id, status]));

    // two paid seats, one viewer: the member turned viewer leaves one paid seat, and two viewers are over it
    expect((await pgError(makeViewer())).hint).toBe("limit:view_seats_per_paid_seat");
    expect(await membership(org, member)).toMatchObject({ role: "member", seat_type: "full" });

    // a suspended viewer holds no seat, so the member may become a viewer
    await setStatus(viewer, "suspended");
    await makeViewer();
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 1, used: 1 });
    // and the suspended viewer cannot come back while the only view seat is taken
    expect((await pgError(setStatus(viewer, "active"))).hint).toBe("limit:view_seats_per_paid_seat");
  });

  it("a business override of the allowance counts; a plan without view seats lists none and refuses a viewer", async () => {
    const owner = await createUser("vs3-owner");
    const org = await createOrg(owner.id, "עסק הרחבה");
    await onPlan(org, "pro", '{"view_seats_per_paid_seat": 2}');
    await addMember(org, owner.id, "viewer", "vs3-a");
    await addMember(org, owner.id, "viewer", "vs3-b");
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 2, used: 2 });
    const third = await createUser("vs3-c");
    expect((await pgError(accept(third, await invite(owner, org, third.email)))).hint).toBe("limit:view_seats_per_paid_seat");

    await onPlan(org, "basic");
    expect(await viewSeats(owner, org)).toBeUndefined();
    expect((await pgError(invite(owner, org, "vs3-d@example.test"))).hint).toBe("feature:view_seats");
  });

  it("the allowance helpers are not callable by anyone but their callers", async () => {
    const grants = await asAdmin(
      async (q) =>
        (await q<{ cap_auth: boolean; cap_anon: boolean; assert_anon: boolean }>(
          `select has_function_privilege('authenticated', 'app.view_seat_cap(uuid, uuid)', 'execute') as cap_auth,
                  has_function_privilege('anon', 'app.view_seat_cap(uuid, uuid)', 'execute') as cap_anon,
                  has_function_privilege('anon', 'app.assert_view_seat_available(uuid, uuid)', 'execute') as assert_anon`,
        )).rows[0],
    );
    expect(grants).toEqual({ cap_auth: false, cap_anon: false, assert_anon: false });
  });
});

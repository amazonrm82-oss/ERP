import { afterAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Usage = { usage: Array<{ key: string; limit: number | null; used: number }> };

// PRM-02 change (owner, 18 October 2026): the view seat allowance is view_seats_per_paid_seat x the full seats bought in
// the subscription (subscriptions.seats), not the active full-seat members. While no seats are bought (seats null, a
// trial) the old rule stays: the active full seats. Seats already over the allowance stay; nothing is suspended.
describe("view seats count by purchased seats (PRM-02)", () => {
  const onPlan = (org: string, seats: number | null, overrides = "{}") =>
    asAdmin((q) =>
      q("update public.subscriptions set plan_key = 'pro', status = 'active', seats = $2, limit_overrides = $3::jsonb where organization_id = $1", [
        org,
        seats,
        overrides,
      ]),
    );
  const setSeats = (org: string, seats: number | null) =>
    asAdmin((q) => q("update public.subscriptions set seats = $2 where organization_id = $1", [org, seats]));
  const invite = (owner: U, org: string, email: string, role = "viewer") =>
    asUser(owner.id, async (q) => (await q<{ t: string }>("select public.create_invitation($1, $2, $3) as t", [org, email, role])).rows[0].t);
  const accept = (user: U, token: string) => asUser(user.id, (q) => q("select public.accept_invitation($1)", [token]));
  const viewSeats = (user: U, org: string) =>
    asUser(user.id, async (q) => (await q<{ u: Usage }>("select public.org_plan_usage($1) as u", [org])).rows[0].u.usage.find((row) => row.key === "view_seats"));
  const statuses = (org: string) =>
    asAdmin(
      async (q) =>
        (await q<{ status: string }>("select status from public.memberships where organization_id = $1 and seat_type = 'view' order by created_at", [org])).rows.map(
          (row) => row.status,
        ),
    );
  const setStatus = (owner: U, org: string, user: U, status: string) =>
    asUser(owner.id, (q) => q("update public.memberships set status = $3 where organization_id = $1 and user_id = $2", [org, user.id, status]));

  it("purchased more than active: the purchase counts, so viewers fit beyond the active paid members", async () => {
    const owner = await createUser("vp-owner");
    const org = await createOrg(owner.id, "עסק שקנה מושבים");
    // three seats bought, only the owner holds one
    await onPlan(org, 3);
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 3, used: 0 });
    await addMember(org, owner.id, "viewer", "vp-a");
    await addMember(org, owner.id, "viewer", "vp-b");
    await addMember(org, owner.id, "viewer", "vp-c");
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 3, used: 3 });
    const fourth = await createUser("vp-d");
    const refused = await pgError(accept(fourth, await invite(owner, org, fourth.email)));
    expect(refused.code).toBe("P0001");
    expect(refused.hint).toBe("limit:view_seats_per_paid_seat");
  });

  it("purchased fewer than active: the purchase counts; viewers already over it stay, a new one is refused", async () => {
    const owner = await createUser("vq-owner");
    const org = await createOrg(owner.id, "עסק שהקטין מנוי");
    await onPlan(org, 3);
    await addMember(org, owner.id, "member", "vq-member");
    await addMember(org, owner.id, "member", "vq-member2");
    const first = await addMember(org, owner.id, "viewer", "vq-a");
    await addMember(org, owner.id, "viewer", "vq-b");

    // the business now buys one seat while three full members stay active
    await setSeats(org, 1);
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 1, used: 2 });
    // nobody is suspended automatically
    expect(await statuses(org)).toEqual(["active", "active"]);

    // a new viewer is refused, and a viewer who was suspended cannot come back while over the allowance
    const third = await createUser("vq-c");
    expect((await pgError(accept(third, await invite(owner, org, third.email)))).hint).toBe("limit:view_seats_per_paid_seat");
    await setStatus(owner, org, first, "suspended");
    expect((await pgError(setStatus(owner, org, first, "active"))).hint).toBe("limit:view_seats_per_paid_seat");
  });

  it("with seats bought, a member made a viewer does not shrink the allowance", async () => {
    const owner = await createUser("vr-owner");
    const org = await createOrg(owner.id, "עסק העברה לצפייה");
    await onPlan(org, 2);
    const member = await addMember(org, owner.id, "member", "vr-member");
    await addMember(org, owner.id, "viewer", "vr-viewer");
    // the old rule would give 1 (owner only, the member excluded) and refuse; the purchase gives 2
    await asUser(owner.id, (q) =>
      q("update public.memberships set role = 'viewer', seat_type = 'view' where organization_id = $1 and user_id = $2", [org, member.id]),
    );
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 2, used: 2 });
  });

  it("no seats bought (trial): the active full seats count, as before; buying seats switches to the purchase", async () => {
    const owner = await createUser("vt-owner");
    const org = await createOrg(owner.id, "עסק בניסיון");
    await onPlan(org, null);
    await addMember(org, owner.id, "member", "vt-member");
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 2, used: 0 });
    await addMember(org, owner.id, "viewer", "vt-a");
    await addMember(org, owner.id, "viewer", "vt-b");
    const third = await createUser("vt-c");
    expect((await pgError(accept(third, await invite(owner, org, third.email)))).hint).toBe("limit:view_seats_per_paid_seat");

    await setSeats(org, 5);
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 5, used: 2 });
    await accept(third, await invite(owner, org, third.email));
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 5, used: 3 });
  });

  it("a business override of the allowance multiplies the purchased seats", async () => {
    const owner = await createUser("vo-owner");
    const org = await createOrg(owner.id, "עסק הרחבה ברכישה");
    await onPlan(org, 3, '{"view_seats_per_paid_seat": 2}');
    expect(await viewSeats(owner, org)).toEqual({ key: "view_seats", limit: 6, used: 0 });
  });
});

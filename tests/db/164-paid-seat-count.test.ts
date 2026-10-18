import { afterAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// Owner, 18 October 2026: every per-seat quota counts the full seats bought in the subscription (subscriptions.seats);
// while none are bought (seats null, a trial) the active full seats count, as before. One helper,
// app.paid_seat_count, used by the booking page allowance (max_booking_pages + max_booking_pages_per_user x paid seats)
// and the view seat allowance.
describe("paid seats for per-seat quotas", () => {
  const setPlan = (org: string, seats: number | null, limits: Record<string, unknown>) =>
    asAdmin((q) =>
      q(
        "update public.subscriptions set plan_key = 'pro', status = 'active', seats = $2, feature_overrides = $3::jsonb, limit_overrides = $4::jsonb where organization_id = $1",
        [org, seats, JSON.stringify({ booking_page: true }), JSON.stringify(limits)],
      ),
    );
  const setSeats = (org: string, seats: number | null) =>
    asAdmin((q) => q("update public.subscriptions set seats = $2 where organization_id = $1", [org, seats]));
  const paidSeats = (org: string) =>
    asAdmin(async (q) => (await q<{ n: number }>("select app.paid_seat_count($1) as n", [org])).rows[0].n);
  // a page as the server writes it (the quota trigger runs for every writer)
  const newPage = (org: string, userId: string) =>
    asAdmin((q) => q("insert into public.booking_pages (organization_id, user_id, title) values ($1, $2, 'דף')", [org, userId]));
  const pages = (org: string) =>
    asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.booking_pages where organization_id = $1", [org])).rows[0].n));
  const perSeat = { max_booking_pages: 0, max_booking_pages_per_user: 1 };

  it("purchased more than active: booking pages fit by the purchase", async () => {
    const owner = await createUser("ps-owner");
    const org = await createOrg(owner.id, "עסק שקנה שלושה");
    await setPlan(org, 3, perSeat);
    expect(await paidSeats(org)).toBe(3);
    for (let i = 0; i < 3; i += 1) await newPage(org, owner.id);
    const refused = await pgError(newPage(org, owner.id));
    expect(refused.code).toBe("P0001");
    expect(refused.hint).toBe("limit:max_booking_pages");
  });

  it("purchased fewer than active: the purchase counts; pages already over it stay, a new one waits for more seats", async () => {
    const owner = await createUser("pf-owner");
    const org = await createOrg(owner.id, "עסק שהקטין");
    await setPlan(org, 3, perSeat);
    await addMember(org, owner.id, "member", "pf-a");
    await addMember(org, owner.id, "member", "pf-b");
    for (let i = 0; i < 3; i += 1) await newPage(org, owner.id);

    await setSeats(org, 1);
    expect(await paidSeats(org)).toBe(1);
    expect(await pages(org)).toBe(3);
    expect((await pgError(newPage(org, owner.id))).hint).toBe("limit:max_booking_pages");
    await setSeats(org, 4);
    await newPage(org, owner.id);
    expect(await pages(org)).toBe(4);
  });

  it("no seats bought (trial): the active full seats count, and a new full member makes room", async () => {
    const owner = await createUser("pt-owner");
    const org = await createOrg(owner.id, "עסק בניסיון");
    await setPlan(org, null, perSeat);
    await addMember(org, owner.id, "member", "pt-a");
    // a viewer holds no paid seat
    await asAdmin((q) => q("update public.subscriptions set feature_overrides = feature_overrides || '{\"view_seats\": true}' where organization_id = $1", [org]));
    await addMember(org, owner.id, "viewer", "pt-viewer");
    expect(await paidSeats(org)).toBe(2);
    await newPage(org, owner.id);
    await newPage(org, owner.id);
    expect((await pgError(newPage(org, owner.id))).hint).toBe("limit:max_booking_pages");
    await addMember(org, owner.id, "member", "pt-b");
    await newPage(org, owner.id);
    expect(await pages(org)).toBe(3);
  });

  it("a business override of the per-seat key multiplies the purchased seats and adds the business-wide key", async () => {
    const owner = await createUser("po-owner");
    const org = await createOrg(owner.id, "עסק הרחבה");
    await setPlan(org, 3, { max_booking_pages: 1, max_booking_pages_per_user: 2 });
    for (let i = 0; i < 7; i += 1) await newPage(org, owner.id);
    expect((await pgError(newPage(org, owner.id))).hint).toBe("limit:max_booking_pages");
  });

  it("the view seat allowance uses the same count", async () => {
    const owner = await createUser("pv-owner");
    const org = await createOrg(owner.id, "עסק צפייה");
    await setPlan(org, 4, { view_seats_per_paid_seat: 1 });
    const cap = (exclude: string | null) =>
      asAdmin(async (q) => (await q<{ n: number }>("select app.view_seat_cap($1, $2) as n", [org, exclude])).rows[0].n);
    expect(await cap(null)).toBe(4);
    await setSeats(org, null);
    // trial: the active full seats other than the one excluded
    const member = await addMember(org, owner.id, "member", "pv-a");
    const membership = await asAdmin(
      async (q) => (await q<{ id: string }>("select id from public.memberships where organization_id = $1 and user_id = $2", [org, member.id])).rows[0].id,
    );
    expect(await cap(null)).toBe(2);
    expect(await cap(membership)).toBe(1);
  });

  it("the helper is not callable by clients", async () => {
    const grants = await asAdmin(
      async (q) =>
        (await q<{ auth: boolean; anon: boolean }>(
          `select has_function_privilege('authenticated', 'app.paid_seat_count(uuid, uuid)', 'execute') as auth,
                  has_function_privilege('anon', 'app.paid_seat_count(uuid, uuid)', 'execute') as anon`,
        )).rows[0],
    );
    expect(grants).toEqual({ auth: false, anon: false });
  });
});

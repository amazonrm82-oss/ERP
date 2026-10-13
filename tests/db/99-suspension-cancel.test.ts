import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

// BIL-09 (owner, 13 October 2026): 'cancelled' is its own stage, 90 days after suspension, with
// notices 14 and 3 days before (0163; they replaced 30, 7 and 1); built OFF behind one platform switch.
// Nothing is deleted.
const staffIds: string[] = [];
afterAll(async () => {
  await asAdmin(async (q) => {
    await q("update app.suspension_cancel_settings set enabled = false where id");
    await q("delete from app.platform_staff where user_id = any($1)", [staffIds]);
  });
  await closePool();
});

type U = { id: string; email: string };

/** A business with an owner and an admin, suspended `daysAgo` days ago. */
async function suspendedOrg(label: string, daysAgo: number) {
  const owner = await createUser(`${label}-owner`);
  const org = await createOrg(owner.id, `עסק ${label}`);
  const admin = await addMember(org, owner.id, "admin", `${label}-admin`);
  await asAdmin(async (q) => {
    await q("update public.organizations set status = 'suspended' where id = $1", [org]);
    await q("update app.org_suspensions set suspended_at = now() - make_interval(days => $2) where organization_id = $1 and ended_at is null", [org, daysAgo]);
  });
  return { org, owner, admin };
}

const run = (org: string, at: string) =>
  asAdmin(async (q) => (await q<{ r: Record<string, unknown> }>("select app.run_suspension_cancel($1::timestamptz, $2) as r", [at, org])).rows[0].r);

const statusOf = (org: string) => asAdmin(async (q) => (await q<{ s: string }>("select status::text as s from public.organizations where id = $1", [org])).rows[0].s);

const suspension = (org: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ cancel_at: Date | null; ended_reason: string | null; ended_at: Date | null }>(
          "select cancel_at, ended_reason, ended_at from app.org_suspensions where organization_id = $1 order by id desc limit 1",
          [org],
        )
      ).rows[0],
  );

/** The cancel notices a user got, oldest first. */
const notices = (org: string, userId: string) =>
  asAdmin(
    async (q) =>
      (
        await q<{ title: string }>(
          "select title from public.notifications where organization_id = $1 and user_id = $2 and type = 'system' and title like 'בעוד % ימים החשבון של %' order by created_at, id",
          [org, userId],
        )
      ).rows.map((r) => r.title),
  );

const notice = (days: number, name: string) =>
  `בעוד ${days} ימים החשבון של ${name} ייסגר, המידע יימחק והטפסים באתר יפסיקו לקלוט פניות. כדי להמשיך, חדשו את המנוי.`;

const iso = (d: Date) => d.toISOString();
const plusDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

describe("cancelled 90 days after suspension (OFF by default)", () => {
  let pOwner: U, pSupport: U;

  beforeAll(async () => {
    pOwner = await createUser("cancel-platform-owner");
    pSupport = await createUser("cancel-platform-support");
    staffIds.push(pOwner.id, pSupport.id);
    await asAdmin(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'owner') on conflict (user_id) do update set role = excluded.role", [pOwner.id]);
      await q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [pSupport.id]);
    });
  });

  it("a status change opens and ends a suspension; a restored business is left alone", async () => {
    const { org } = await suspendedOrg("track", 0);
    expect((await suspension(org)).ended_at).toBeNull();
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    expect((await suspension(org)).ended_reason).toBe("restored");
  });

  it("off: nothing happens, however long the business has been suspended", async () => {
    const { org, owner } = await suspendedOrg("off", 200);
    expect(await run(org, iso(new Date()))).toEqual({ enabled: false });
    expect(await run(org, iso(plusDays(new Date(), 400)))).toEqual({ enabled: false });
    expect(await statusOf(org)).toBe("suspended");
    expect((await suspension(org)).cancel_at).toBeNull();
    expect(await notices(org, owner.id)).toEqual([]);
  });

  it("only the platform owner switches it, with a second factor, and it is logged", async () => {
    expect((await pgError(asMfaUser(pSupport.id, (q) => q("select public.platform_set_suspension_cancel(true)")))).code).toBe("42501");
    expect((await pgError(asUser(pOwner.id, (q) => q("select public.platform_set_suspension_cancel(true)")))).code).toBe("42501");
    const someone = await createUser("cancel-someone");
    expect((await pgError(asMfaUser(someone.id, (q) => q("select public.platform_suspension_cancel_status()")))).code).toBe("42501");
    const status = await asMfaUser(pSupport.id, async (q) => (await q<{ s: { enabled: boolean } }>("select public.platform_suspension_cancel_status() as s")).rows[0].s);
    expect(status.enabled).toBe(false);
    await asMfaUser(pOwner.id, (q) => q("select public.platform_set_suspension_cancel(true)"));
    const logged = await asAdmin(async (q) =>
      Number((await q<{ n: string }>("select count(*) as n from app.platform_log where action = 'suspension_cancel.switch' and actor_id = $1", [pOwner.id])).rows[0].n),
    );
    expect(logged).toBe(1);
  });

  it("on: the owner gets the 14 and 3 day notices once each, and the business is cancelled at 90 days", async () => {
    const { org, owner, admin } = await suspendedOrg("on", 0);
    const start = new Date();
    // day 1: the cancel day is planned, about 90 days after the suspension; nothing is due yet
    expect(await run(org, iso(plusDays(start, 1)))).toMatchObject({ enabled: true, planned: 1, notices: 0, cancelled: 0 });
    const cancelAt = (await suspension(org)).cancel_at as Date;
    const days = (cancelAt.getTime() - start.getTime()) / 86_400_000;
    expect(days).toBeGreaterThanOrEqual(90);
    expect(days).toBeLessThanOrEqual(91.1);

    // 14 days before, then again the next day: one notice
    await run(org, iso(plusDays(cancelAt, -13.9)));
    await run(org, iso(plusDays(cancelAt, -12.9)));
    expect(await notices(org, owner.id)).toEqual([notice(14, "עסק on")]);
    // 3 days before, twice
    await run(org, iso(plusDays(cancelAt, -2.9)));
    await run(org, iso(plusDays(cancelAt, -2.5)));
    const sent = await notices(org, owner.id);
    expect(sent).toEqual([notice(14, "עסק on"), notice(3, "עסק on")]);
    expect((await suspension(org)).cancel_at).toEqual(cancelAt);
    // the notice leads to the plan page and carries nothing else
    const row = await asAdmin(
      async (q) =>
        (await q<{ body: string | null; entity_type: string; entity_id: string }>("select body, entity_type, entity_id from public.notifications where organization_id = $1 and user_id = $2 and title = $3", [org, owner.id, sent[1]])).rows[0],
    );
    expect(row).toEqual({ body: null, entity_type: "subscription", entity_id: org });
    // the admin has no access to a suspended business, and is not told
    expect(await notices(org, admin.id)).toEqual([]);
    expect(await statusOf(org)).toBe("suspended");

    // the day itself: cancelled, logged, nothing deleted
    expect(await run(org, iso(plusDays(cancelAt, 0.01)))).toMatchObject({ cancelled: 1 });
    expect(await statusOf(org)).toBe("cancelled");
    expect((await suspension(org)).ended_reason).toBe("cancelled");
    expect(await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from app.platform_log where action = 'suspension.cancelled' and organization_id = $1", [org])).rows[0].n))).toBe(1);
    expect(await asAdmin(async (q) => Number((await q<{ n: string }>("select count(*) as n from public.memberships where organization_id = $1", [org])).rows[0].n))).toBe(2);
    // later runs leave it as it is
    expect(await run(org, iso(plusDays(cancelAt, 10)))).toMatchObject({ planned: 0, notices: 0, cancelled: 0 });
    expect(await notices(org, owner.id)).toHaveLength(2);
  });

  it("on: a business suspended long before the switch still gets 14 days of notice", async () => {
    const { org, owner } = await suspendedOrg("old", 200);
    const now = new Date();
    await run(org, iso(now));
    const cancelAt = (await suspension(org)).cancel_at as Date;
    expect(cancelAt.getTime()).toBeGreaterThanOrEqual(plusDays(now, 14).getTime());
    // the job missed days: 3 days before only the most urgent notice goes out, and the day holds
    await run(org, iso(plusDays(cancelAt, -2.9)));
    expect(await notices(org, owner.id)).toEqual([notice(3, "עסק old")]);
    expect((await suspension(org)).cancel_at).toEqual(cancelAt);
    await run(org, iso(plusDays(cancelAt, 0.01)));
    expect(await statusOf(org)).toBe("cancelled");
  });

  it("on: a late 3-day notice moves the day, so the owner always has 3 days", async () => {
    const { org, owner } = await suspendedOrg("late", 0);
    await run(org, iso(new Date()));
    const cancelAt = (await suspension(org)).cancel_at as Date;
    // the first run after the day: notice, no cancel yet
    await run(org, iso(plusDays(cancelAt, 0.5)));
    expect(await statusOf(org)).toBe("suspended");
    const moved = (await suspension(org)).cancel_at as Date;
    expect(moved.getTime()).toBeGreaterThan(plusDays(cancelAt, 2.5).getTime());
    expect(await notices(org, owner.id)).toEqual([notice(3, "עסק late")]);
    await run(org, iso(plusDays(moved, -0.5)));
    expect(await statusOf(org)).toBe("suspended");
    await run(org, iso(plusDays(moved, 0.01)));
    expect(await statusOf(org)).toBe("cancelled");
  });

  it("on: a business restored before the day is left alone", async () => {
    const { org, owner } = await suspendedOrg("restored", 0);
    await run(org, iso(new Date()));
    const cancelAt = (await suspension(org)).cancel_at as Date;
    await run(org, iso(plusDays(cancelAt, -13.9)));
    expect(await notices(org, owner.id)).toHaveLength(1);
    await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    expect(await run(org, iso(plusDays(cancelAt, -1)))).toMatchObject({ notices: 0, cancelled: 0 });
    expect(await run(org, iso(plusDays(cancelAt, 1)))).toMatchObject({ notices: 0, cancelled: 0 });
    expect(await statusOf(org)).toBe("active");
    expect(await notices(org, owner.id)).toHaveLength(1);
    // suspended again: a new 90 days, from now
    await asAdmin((q) => q("update public.organizations set status = 'suspended' where id = $1", [org]));
    const again = await suspension(org);
    expect(again.ended_at).toBeNull();
    expect(again.cancel_at).toBeNull();
  });

  it("switching off clears the planned days; nothing happens until it is on again", async () => {
    const { org, owner } = await suspendedOrg("switch", 0);
    await run(org, iso(new Date()));
    expect((await suspension(org)).cancel_at).not.toBeNull();
    await asMfaUser(pOwner.id, (q) => q("select public.platform_set_suspension_cancel(false)"));
    expect((await suspension(org)).cancel_at).toBeNull();
    expect(await run(org, iso(plusDays(new Date(), 200)))).toEqual({ enabled: false });
    expect(await statusOf(org)).toBe("suspended");
    expect(await notices(org, owner.id)).toEqual([]);
  });
});

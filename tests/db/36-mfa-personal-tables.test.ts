import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

describe("two-step verification guards the personal tables too (FXS-03)", () => {
  let owner: { id: string }, colleague: { id: string }, plain: { id: string };
  let org: string;

  beforeAll(async () => {
    owner = await createUser("mfa-personal-owner");
    org = await createOrg(owner.id);
    colleague = await addMember(org, owner.id, "member", "mfa-personal-colleague");
    // the owner turned two-step verification on for their account
    await asAdmin(async (q) => {
      await q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [owner.id]);
      await q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'system', 'שם לקוח')", [org, owner.id]);
      await q("insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, 'https://push.example/owner', 'k', 'a')", [owner.id]);
      await q("insert into public.notification_settings (user_id) values ($1) on conflict do nothing", [owner.id]);
      await q("insert into public.saved_views (organization_id, owner_id, object_type, name) values ($1, $2, 'lead', 'שלי')", [org, owner.id]);
    });
    plain = await createUser("mfa-personal-plain");
  });

  const personal = (run: typeof asUser, userId: string) =>
    run(userId, async (q) => ({
      notifications: await count(q, "select 1 from public.notifications"),
      push: await count(q, "select 1 from public.push_subscriptions"),
      settings: await count(q, "select 1 from public.notification_settings"),
      colleagues: await count(q, "select 1 from public.profiles where id <> $1", [userId]),
      self: await count(q, "select 1 from public.profiles where id = $1", [userId]),
      views: await count(q, "select 1 from public.saved_views"),
    }));

  it("a password-only session reads only its own profile", async () => {
    expect(await personal(asUser, owner.id)).toEqual({ notifications: 0, push: 0, settings: 0, colleagues: 0, self: 1, views: 0 });
  });

  it("after the second step everything is back", async () => {
    expect(await personal(asMfaUser, owner.id)).toEqual({ notifications: 1, push: 1, settings: 1, colleagues: 1, self: 1, views: 1 });
  });

  it("a password-only session cannot register a device, mark notifications or clear backup codes", async () => {
    expect((await pgError(asUser(owner.id, (q) => q("insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/thief', 'k', 'a')")))).code).toBe("42501");
    const marked = await asUser(owner.id, async (q) => (await q("update public.notifications set read_at = now()")).rowCount);
    expect(marked).toBe(0);
    expect((await pgError(asUser(owner.id, (q) => q("select public.mfa_recovery_codes_clear()")))).code).toBe("42501");
    await asMfaUser(owner.id, (q) => q("select public.mfa_recovery_codes_clear()"));
  });

  it("someone without two-step verification, in no organization that requires it, is not affected", async () => {
    expect(await asUser(colleague.id, (q) => count(q, "select 1 from public.profiles where id = $1", [owner.id]))).toBe(1);
    await asUser(plain.id, (q) => q("insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/plain', 'k', 'a')"));
    expect(await asUser(plain.id, (q) => count(q, "select 1 from public.push_subscriptions"))).toBe(1);
  });

  it("an organization that requires two-step verification closes them for its members until they have it", async () => {
    await asAdmin((q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
    await asAdmin((q) => q("insert into public.notifications (organization_id, user_id, type, title) values ($1, $2, 'system', 'x')", [org, colleague.id]));
    expect(await asUser(colleague.id, (q) => count(q, "select 1 from public.notifications"))).toBe(0);
    expect(await asMfaUser(colleague.id, (q) => count(q, "select 1 from public.notifications"))).toBe(1);
    await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
  });
});

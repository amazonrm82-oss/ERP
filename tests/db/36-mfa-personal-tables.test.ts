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

  it("a password-only session cannot delete notifications, devices or views, or change its profile (RVW-13)", async () => {
    const changed = await asUser(owner.id, async (q) => ({
      notifications: (await q("delete from public.notifications")).rowCount,
      push: (await q("delete from public.push_subscriptions")).rowCount,
      views: (await q("delete from public.saved_views")).rowCount,
      profile: (await q("update public.profiles set full_name = 'גנב' where id = $1", [owner.id])).rowCount,
    }));
    expect(changed).toEqual({ notifications: 0, push: 0, views: 0, profile: 0 });
    const left = await asAdmin(async (q) => ({
      notifications: await count(q, "select 1 from public.notifications where user_id = $1", [owner.id]),
      push: await count(q, "select 1 from public.push_subscriptions where user_id = $1", [owner.id]),
      views: await count(q, "select 1 from public.saved_views where owner_id = $1", [owner.id]),
      profile: await count(q, "select 1 from public.profiles where id = $1 and full_name = 'גנב'", [owner.id]),
    }));
    expect(left).toEqual({ notifications: 1, push: 1, views: 1, profile: 0 });
    // the same statements work after the second step (checked inside a rolled-back transaction)
    const verified = await pgError(
      asMfaUser(owner.id, async (q) => {
        const counts = {
          notifications: (await q("delete from public.notifications")).rowCount,
          push: (await q("delete from public.push_subscriptions")).rowCount,
          views: (await q("delete from public.saved_views")).rowCount,
          profile: (await q("update public.profiles set full_name = full_name where id = $1", [owner.id])).rowCount,
        };
        throw Object.assign(new Error(JSON.stringify(counts)), { code: "rollback" });
      }),
    );
    expect(JSON.parse(verified.message)).toEqual({ notifications: 1, push: 1, views: 1, profile: 1 });
  });

  it("a password-only session can neither change notification settings nor list devices (RVW-13)", async () => {
    await asAdmin((q) => q("insert into auth.sessions (user_id, user_agent, ip) values ($1, 'Chrome', '10.0.0.7')", [owner.id]));
    const refused = await pgError(asUser(owner.id, (q) => q("select public.set_notification_settings($1, '{}')", [["assigned"]])));
    expect(refused.code).toBe("42501");
    expect(refused.hint).toBe("mfa:aal2_required");
    const hidden = await pgError(asUser(owner.id, (q) => q("select public.my_sessions()")));
    expect(hidden.code).toBe("42501");
    expect(hidden.hint).toBe("mfa:aal2_required");
    expect(await asAdmin((q) => count(q, "select 1 from public.notification_settings where user_id = $1 and muted <> '{}'", [owner.id]))).toBe(0);

    await asMfaUser(owner.id, (q) => q("select public.set_notification_settings($1, '{}')", [["assigned"]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.notification_settings where user_id = $1 and muted = '{assigned}'", [owner.id]))).toBe(1);
    await asMfaUser(owner.id, (q) => q("select public.set_notification_settings('{}', '{}')"));
    const sessions = await asMfaUser(owner.id, async (q) => (await q<{ r: Array<{ ip: string }> }>("select public.my_sessions() as r")).rows[0].r);
    expect(sessions.map((s) => s.ip)).toContain("10.0.0.7");

    // without two-step verification nothing changes
    await asUser(plain.id, (q) => q("select public.set_notification_settings($1, '{}')", [["assigned"]]));
    expect(await asAdmin((q) => count(q, "select 1 from public.notification_settings where user_id = $1 and muted = '{assigned}'", [plain.id]))).toBe(1);
    await asUser(plain.id, (q) => q("select public.set_notification_settings('{}', '{}')"));
    expect(await asUser(plain.id, async (q) => (await q<{ r: unknown[] }>("select public.my_sessions() as r")).rows[0].r)).toEqual([]);
  });

  it("a password-only session can read neither its signed agreement nor its backup code status (RVW-13)", async () => {
    const docs = JSON.stringify([{ slug: "terms", title: "תנאים", version: "v", text: "טקסט" }]);
    const sign = (userId: string) => asUser(userId, (q) => q("select public.sign_agreement('v', $1, 'דנה כהן', 'typed', null)", [docs]));
    await sign(owner.id); // signing stays open to a password-only session
    await sign(plain.id);
    const agreement = (run: typeof asUser, userId: string) =>
      run(userId, async (q) => (await q<{ r: { full_name: string } | null }>("select public.my_agreement() as r")).rows[0].r);
    const codes = (run: typeof asUser, userId: string) =>
      run(userId, async (q) => (await q<{ r: { remaining: number } }>("select public.mfa_recovery_codes_status() as r")).rows[0].r);

    for (const read of [agreement(asUser, owner.id), codes(asUser, owner.id)]) {
      const refused = await pgError(read);
      expect(refused.code).toBe("42501");
      expect(refused.hint).toBe("mfa:aal2_required");
    }
    expect((await agreement(asMfaUser, owner.id))?.full_name).toBe("דנה כהן");
    expect((await codes(asMfaUser, owner.id)).remaining).toBe(0);

    // without two-step verification nothing changes
    expect((await agreement(asUser, plain.id))?.full_name).toBe("דנה כהן");
    expect((await codes(asUser, plain.id)).remaining).toBe(0);
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
    // RVW-13: also for someone with no authenticator yet (the account page shows a note instead)
    expect((await pgError(asUser(colleague.id, (q) => q("select public.my_sessions()")))).hint).toBe("mfa:aal2_required");
    await asAdmin((q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
  });
});

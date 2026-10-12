import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

describe("account security", () => {
  let owner: U, member: U, outsider: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member");
    outsider = await createUser("outsider");
    await insertLead(member.id, org, { owner_id: member.id });
  });

  it("only a verified session can require two-step verification for the organization", async () => {
    const err = await pgError(asUser(owner.id, (q) => q("update public.organizations set require_mfa = true where id = $1", [org])));
    expect(err.hint).toBe("mfa:self_first");
    // a member cannot change it at all
    await asMfaUser(member.id, async (q) => {
      expect((await q("update public.organizations set require_mfa = true where id = $1", [org])).rowCount).toBe(0);
    });
    await asMfaUser(owner.id, (q) => q("update public.organizations set require_mfa = true where id = $1", [org]));
  });

  it("with the requirement on, an unverified session sees nothing of the organization", async () => {
    const leads = (verified: boolean) =>
      (verified ? asMfaUser : asUser)(member.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]));
    expect(await leads(false)).toBe(0);
    expect(await leads(true)).toBe(1);
    expect((await pgError(insertLead(member.id, org))).code).toBe("42501");
    const blocked = await asUser(member.id, async (q) => (await q<{ r: Array<{ id: string }> }>("select public.mfa_required_orgs() as r")).rows[0].r);
    expect(blocked.map((o) => o.id)).toEqual([org]);
    expect(await asMfaUser(member.id, async (q) => (await q<{ r: unknown[] }>("select public.mfa_required_orgs() as r")).rows[0].r)).toEqual([]);
    // turning it off again restores normal access
    await asMfaUser(owner.id, (q) => q("update public.organizations set require_mfa = false where id = $1", [org]));
    expect(await leads(false)).toBe(1);
  });

  it("each user sees only their own sessions; login events are for the organization's admins", async () => {
    const mine = await asAdmin(async (q) => {
      const s = (await q<{ id: string }>("insert into auth.sessions (user_id, user_agent, ip) values ($1, 'Chrome', '10.0.0.1') returning id", [member.id])).rows[0].id;
      await q("insert into auth.sessions (user_id, user_agent) values ($1, 'Safari')", [owner.id]);
      await q("insert into auth.audit_log_entries (payload, ip_address) values ($1, '10.0.0.1')", [JSON.stringify({ action: "login", actor_id: member.id })]);
      await q("insert into auth.audit_log_entries (payload, ip_address) values ($1, '10.9.9.9')", [JSON.stringify({ action: "login", actor_id: outsider.id })]);
      return s;
    });
    const sessions = await asUser(
      member.id,
      async (q) => (await q<{ r: Array<{ id: string; user_agent: string; is_current: boolean }> }>("select public.my_sessions() as r")).rows[0].r,
      { session_id: mine },
    );
    expect(sessions.map((s) => s.user_agent)).toEqual(["Chrome"]);
    expect(sessions[0].is_current).toBe(true);

    expect((await pgError(asUser(member.id, (q) => q("select public.org_login_events($1)", [org])))).code).toBe("42501");
    const events = await asUser(owner.id, async (q) => (await q<{ r: Array<{ user_id: string; ip: string }> }>("select public.org_login_events($1) as r", [org])).rows[0].r);
    expect(events.map((e) => e.user_id)).toContain(member.id);
    expect(events.map((e) => e.user_id)).not.toContain(outsider.id);
    // the Supabase Auth tables themselves stay out of reach
    for (const sql of ["select * from auth.sessions", "select * from auth.audit_log_entries"]) {
      expect((await pgError(asUser(owner.id, (q) => q(sql)))).code).toBe("42501");
    }
  });
});

describe("two-step verification turned on by the user", () => {
  it("a session without the code sees nothing of any organization; with it, everything as before", async () => {
    const user = await createUser("careful");
    const org = await createOrg(user.id);
    await insertLead(user.id, org);
    await asAdmin((q) => q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [user.id]));
    expect(await asUser(user.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(0);
    expect(await asMfaUser(user.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(1);
    const blocked = await asUser(user.id, async (q) => (await q<{ r: Array<{ id: string }> }>("select public.mfa_required_orgs() as r")).rows[0].r);
    expect(blocked.map((o) => o.id)).toEqual([org]);
    expect(await asUser(user.id, async (q) => (await q<{ r: unknown }>("select public.mfa_status() as r")).rows[0].r)).toEqual({ enrolled: true, aal: "" });
    // an authenticator that was never confirmed changes nothing
    const other = await createUser("half-done");
    const otherOrg = await createOrg(other.id);
    await asAdmin((q) => q("insert into auth.mfa_factors (user_id, status) values ($1, 'unverified')", [other.id]));
    expect(await asUser(other.id, (q) => count(q, "select 1 from public.organizations where id = $1", [otherOrg]))).toBe(1);
  });
});

describe("backup codes for two-step verification", () => {
  type R<T> = { r: T };
  const create = (userId: string) => asMfaUser(userId, async (q) => (await q<R<string[]>>("select public.mfa_recovery_codes_create() as r")).rows[0].r);
  const recover = (userId: string, code: string) =>
    asUser(userId, async (q) => (await q<R<{ ok: boolean; reason?: string }>>("select public.mfa_recover($1) as r", [code])).rows[0].r);
  // read in a verified session, as the account page does (RVW-13: a password-only session is refused, test 36)
  const status = (userId: string) => asMfaUser(userId, async (q) => (await q<R<{ remaining: number }>>("select public.mfa_recovery_codes_status() as r")).rows[0].r);
  const factors = (userId: string) => asAdmin((q) => count(q, "select 1 from auth.mfa_factors where user_id = $1", [userId]));

  let user: U, org: string;
  beforeAll(async () => {
    user = await createUser("lost-phone");
    org = await createOrg(user.id);
    await insertLead(user.id, org);
    await asAdmin((q) => q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [user.id]));
  });

  it("only a verified session creates codes; they are shown once and stored hashed", async () => {
    expect((await pgError(asUser(user.id, (q) => q("select public.mfa_recovery_codes_create()")))).hint).toBe("mfa:aal2_required");
    const noFactor = await createUser("no-factor");
    expect((await pgError(asMfaUser(noFactor.id, (q) => q("select public.mfa_recovery_codes_create()")))).hint).toBe("mfa:aal2_required");

    const codes = await create(user.id);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect((await status(user.id)).remaining).toBe(10);
    // nothing of it is reachable from the API, and the plain codes are stored nowhere
    for (const sql of ["select * from app.mfa_recovery_codes", "select * from app.mfa_recovery_attempts"]) {
      expect((await pgError(asMfaUser(user.id, (q) => q(sql)))).code).toBe("42501");
    }
    const stored = await asAdmin(async (q) => (await q<{ code_hash: string }>("select code_hash from app.mfa_recovery_codes where user_id = $1", [user.id])).rows);
    expect(stored.map((s) => s.code_hash)).not.toContain(codes[0].replaceAll("-", ""));
    // new codes replace the old ones
    const again = await create(user.id);
    expect((await recover(user.id, codes[0])).reason).toBe("wrong");
    expect((await status(user.id)).remaining).toBe(10);
    (globalThis as Record<string, unknown>).__codes = again;
  });

  it("someone else's code does not work, and wrong tries are limited", async () => {
    const codes = (globalThis as Record<string, unknown>).__codes as string[];
    const other = await createUser("other-user");
    await asAdmin((q) => q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [other.id]));
    expect((await recover(other.id, codes[0])).reason).toBe("wrong");
    expect(await factors(user.id)).toBe(1);

    const tries = await createUser("guesser");
    await asAdmin((q) => q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [tries.id]));
    const triesCodes = await create(tries.id);
    for (let i = 0; i < 5; i++) expect((await recover(tries.id, "0000-0000-0000")).reason).toBe("wrong");
    // even the right code is refused now
    expect((await recover(tries.id, triesCodes[0])).reason).toBe("too_many");
    expect(await factors(tries.id)).toBe(1);
    // no signed-in user, no recovery
    expect((await pgError(asAnonRecover(codes[0]))).code).toBe("42501");
  });

  it("a good code removes the authenticator once, opens the organization and is logged", async () => {
    const codes = (globalThis as Record<string, unknown>).__codes as string[];
    expect(await asUser(user.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(0);
    // spaces, upper case and missing dashes are fine
    expect(await recover(user.id, ` ${codes[3].toUpperCase().replaceAll("-", "")} `)).toEqual({ ok: true });
    expect(await factors(user.id)).toBe(0);
    expect(await asUser(user.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'mfa_recovery' and actor_id = $2", [org, user.id]))).toBe(1);
    // the codes went with the authenticator
    expect(await asAdmin((q) => count(q, "select 1 from app.mfa_recovery_codes where user_id = $1", [user.id]))).toBe(0);
    expect((await recover(user.id, codes[4])).reason).toBe("no_factor");
    expect((await status(user.id)).remaining).toBe(0);
  });
});

function asAnonRecover(code: string) {
  return asAnon((q) => q("select public.mfa_recover($1)", [code]));
}

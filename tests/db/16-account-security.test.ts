import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

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

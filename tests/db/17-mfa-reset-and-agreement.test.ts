import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError, type Query } from "./helpers";
import { AGREEMENT_VERSION, agreementSnapshot } from "@/features/legal/agreement";

afterAll(closePool);

type U = { id: string; email: string };
const giveFactor = (userId: string) => asAdmin((q) => q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [userId]));
const factors = (userId: string) => asAdmin((q) => count(q, "select 1 from auth.mfa_factors where user_id = $1", [userId]));
const sessions = (userId: string) => asAdmin((q) => count(q, "select 1 from auth.sessions where user_id = $1", [userId]));
const addSession = (userId: string) => asAdmin((q) => q("insert into auth.sessions (user_id, user_agent) values ($1, 'Chrome')", [userId]));
const makeStaff = (userId: string, role: string) =>
  asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));

describe("two-step verification reset by the organization", () => {
  let owner: U, admin: U, member: U, otherAdmin: U, multi: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("reset-owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    otherAdmin = await addMember(org, owner.id, "admin");
    member = await addMember(org, owner.id, "member");
    multi = await addMember(org, owner.id, "member");
    const elsewhere = await createOrg((await createUser("other-biz")).id);
    await asAdmin((q) => q("insert into public.memberships (organization_id, user_id, role, status) values ($1, $2, 'member', 'active')", [elsewhere, multi.id]));
    for (const u of [owner, admin, otherAdmin, member, multi]) await giveFactor(u.id);
    await addSession(member.id);
  });

  const reset = (actor: string, target: string, verified = true) =>
    (verified ? asMfaUser : asUser)(actor, (q) => q("select public.org_reset_member_mfa($1, $2)", [org, target]));

  it("only owners and admins with a verified session, only for people they manage, only within one business", async () => {
    expect((await pgError(reset(member.id, multi.id))).code).toBe("42501");
    // without the code in this session the admin is not even a member (they have a factor)
    expect((await pgError(reset(admin.id, member.id, false))).code).toBe("42501");
    expect((await pgError(reset(admin.id, otherAdmin.id))).code).toBe("42501");
    expect((await pgError(reset(admin.id, owner.id))).code).toBe("42501");
    expect((await pgError(reset(admin.id, admin.id))).code).toBe("42501");
    expect((await pgError(reset(admin.id, multi.id))).hint).toBe("mfa_reset:other_orgs");
    expect(await factors(multi.id)).toBe(1);
    // admins see who has two-step verification; members do not
    const list = await asMfaUser(admin.id, async (q) => (await q<{ r: string[] }>("select public.org_members_mfa($1) as r", [org])).rows[0].r);
    expect(list).toContain(member.id);
    expect((await pgError(asMfaUser(member.id, (q) => q("select public.org_members_mfa($1)", [org])))).code).toBe("42501");
  });

  it("a reset removes the authenticator and codes, signs out everywhere, is logged and notified", async () => {
    await reset(admin.id, member.id);
    expect(await factors(member.id)).toBe(0);
    expect(await sessions(member.id)).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'mfa_reset' and actor_id = $2", [org, admin.id]))).toBe(1);
    const notified = await asAdmin(async (q) => (await q<{ user_id: string }>("select user_id from public.notifications where organization_id = $1 and title like '%אופס%'", [org])).rows.map((r) => r.user_id));
    expect(notified).toEqual(expect.arrayContaining([member.id, owner.id, otherAdmin.id]));
    expect(notified).not.toContain(admin.id);
    expect((await pgError(reset(admin.id, member.id))).hint).toBe("mfa_reset:none");
    // the owner may reset an admin
    await reset(owner.id, otherAdmin.id);
    expect(await factors(otherAdmin.id)).toBe(0);
  });
});

describe("two-step verification reset by platform support", () => {
  let support: U, readonly: U, customer: U;

  beforeAll(async () => {
    support = await createUser("p-support");
    readonly = await createUser("p-readonly");
    customer = await createUser("customer-locked");
    await createOrg(customer.id);
    await makeStaff(support.id, "support");
    await makeStaff(readonly.id, "readonly");
    await giveFactor(customer.id);
  });

  const reset = (actor: string, target: string, reason = "אבד הטלפון", check = "video_id") =>
    asMfaUser(actor, (q) => q("select public.platform_reset_mfa($1, $2, $3)", [target, reason, check]));

  it("support finds the user and resets after an identity check; it is in the permanent log", async () => {
    const found = await asMfaUser(readonly.id, async (q) => (await q<{ r: { id: string; mfa: boolean; orgs: unknown[] } }>("select public.platform_find_user($1) as r", [customer.email.toUpperCase()])).rows[0].r);
    expect(found.id).toBe(customer.id);
    expect(found.mfa).toBe(true);
    expect(found.orgs).toHaveLength(1);
    expect((await pgError(asUser(support.id, (q) => q("select public.platform_find_user($1)", [customer.email])))).code).toBe("42501");

    expect((await pgError(reset(readonly.id, customer.id))).code).toBe("42501");
    expect((await pgError(reset(support.id, customer.id, "  "))).code).toBe("22023");
    expect((await pgError(reset(support.id, customer.id, "x", "trust me"))).code).toBe("22023");
    await reset(support.id, customer.id);
    expect(await factors(customer.id)).toBe(0);
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'user.mfa_reset' and actor_id = $1", [support.id]))).toBe(1);
  });

  it("only a platform owner resets another platform owner", async () => {
    // platform owners exist only inside this transaction, which is rolled back:
    // 15-platform.test.ts counts owners ("the last owner cannot leave")
    const a = await createUser("p-owner-a");
    const b = await createUser("p-owner-b");
    const asRole = async (q: Query, userId: string) => {
      await q("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2" })]);
      await q("set local role authenticated");
    };
    const call = "select public.platform_reset_mfa($1, 'אבד הטלפון', 'video_id')";
    await asAdmin(async (q) => {
      await q("insert into app.platform_staff (user_id, role) values ($1, 'owner'), ($2, 'owner')", [a.id, b.id]);
      await q("insert into auth.mfa_factors (user_id, status) values ($1, 'verified')", [b.id]);
      await q("savepoint before_support");
      await asRole(q, support.id);
      expect((await pgError(q(call, [b.id]))).code).toBe("42501");
      await q("rollback to savepoint before_support");
      await asRole(q, a.id);
      await q(call, [b.id]);
      await q("reset role");
      expect(await count(q, "select 1 from auth.mfa_factors where user_id = $1", [b.id])).toBe(0);
      throw new Error("rollback");
    }).catch((error: Error) => {
      if (error.message !== "rollback") throw error;
    });
  });
});

describe("signed agreement", () => {
  // the app's own texts: sign_agreement() accepts only the registered texts of a version (FXS-09)
  const docs = JSON.stringify(agreementSnapshot());
  const sign = (userId: string, method = "typed", signature: string | null = null) =>
    asUser(userId, (q) => q("select public.sign_agreement($1, $2, 'דנה כהן', $3, $4)", [AGREEMENT_VERSION, docs, method, signature]));

  it("a user signs their own copy, which keeps the text and its hash, and nobody can change it", async () => {
    const user = await createUser("signer");
    expect(await asUser(user.id, async (q) => (await q<{ r: string | null }>("select public.agreement_status() as r")).rows[0].r)).toBeNull();
    await sign(user.id);
    expect(await asUser(user.id, async (q) => (await q<{ r: string }>("select public.agreement_status() as r")).rows[0].r)).toBe(AGREEMENT_VERSION);
    const copy = await asUser(user.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.my_agreement() as r")).rows[0].r);
    expect(copy.full_name).toBe("דנה כהן");
    expect(copy.documents).toEqual(JSON.parse(docs));
    // the stored hash is of the stored text
    const ok = await asAdmin(async (q) =>
      (await q<{ ok: boolean }>("select content_hash = encode(sha256(convert_to(documents::text, 'UTF8')), 'hex') as ok from app.agreement_signatures where user_id = $1", [user.id])).rows[0].ok,
    );
    expect(ok).toBe(true);
    // another user does not see it; the table is not reachable from the API
    const other = await createUser("not-signer");
    expect(await asUser(other.id, async (q) => (await q<{ r: unknown }>("select public.my_agreement() as r")).rows[0].r)).toBeNull();
    for (const sql of ["select * from app.agreement_signatures", "delete from app.agreement_signatures", "update app.agreement_signatures set full_name = 'x'"]) {
      expect((await pgError(asUser(user.id, (q) => q(sql)))).code).toBe("42501");
    }
  });

  it("a drawn signature must be a PNG image; a typed one has none", async () => {
    const user = await createUser("drawer");
    expect((await pgError(sign(user.id, "drawn", null))).code).toBe("23514");
    expect((await pgError(sign(user.id, "drawn", "javascript:alert(1)"))).code).toBe("23514");
    await sign(user.id, "drawn", "data:image/png;base64,iVBORw0KGgo=");
    expect((await pgError(asUser(user.id, (q) => q("select public.sign_agreement('v', '[]', 'דנה כהן', 'typed', null)")))).code).toBe("22023");
  });
});

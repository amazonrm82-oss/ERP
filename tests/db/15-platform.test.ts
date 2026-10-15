import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

const makeStaff = (userId: string, role: string) =>
  asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));

describe("platform admin", () => {
  let owner: U, admin: U, member: U, pOwner: U, support: U, finance: U, readonly: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("customer-owner");
    org = await createOrg(owner.id, "לקוח לדוגמה");
    admin = await addMember(org, owner.id, "admin");
    member = await addMember(org, owner.id, "member");
    await insertLead(owner.id, org, { full_name: "ליד של הלקוח" });
    pOwner = await createUser("platform-owner");
    support = await createUser("platform-support");
    finance = await createUser("platform-finance");
    readonly = await createUser("platform-readonly");
    await makeStaff(pOwner.id, "owner");
    await makeStaff(support.id, "support");
    await makeStaff(finance.id, "finance");
    await makeStaff(readonly.id, "readonly");
  });

  it("nothing opens without a platform role and a second factor", async () => {
    // a customer, even with MFA
    expect((await pgError(asMfaUser(owner.id, (q) => q("select public.platform_list_orgs()")))).code).toBe("42501");
    // platform owner without the second factor
    expect((await pgError(asUser(pOwner.id, (q) => q("select public.platform_list_orgs()")))).code).toBe("42501");
    const me = await asUser(pOwner.id, async (q) => (await q<{ r: { role: string; needs_mfa: boolean } }>("select public.platform_me() as r")).rows[0].r);
    expect(me).toEqual({ role: "owner", needs_mfa: true });
    expect(await asUser(owner.id, async (q) => (await q<{ r: unknown }>("select public.platform_me() as r")).rows[0].r)).toBeNull();
    // with it
    const list = await asMfaUser(readonly.id, async (q) => (await q<{ r: { total: number; rows: Array<{ id: string; owner_email: string }> } }>("select public.platform_list_orgs() as r")).rows[0].r);
    expect(list.rows.find((r) => r.id === org)?.owner_email).toBe(owner.email);
    // the staff table and the log are not reachable from the API at all
    for (const sql of ["select * from app.platform_staff", "select * from app.platform_log"]) {
      expect((await pgError(asMfaUser(pOwner.id, (q) => q(sql)))).code).toBe("42501");
    }
  });

  it("each action needs its role, and every action is logged for good", async () => {
    const changePlan = (userId: string) =>
      asMfaUser(userId, (q) => q("select public.platform_update_subscription($1, 'basic', 5, now() + interval '30 days', 'פיילוט')", [org]));
    expect((await pgError(changePlan(readonly.id))).code).toBe("42501");
    expect((await pgError(changePlan(support.id))).code).toBe("42501");
    await changePlan(finance.id);
    expect(await asAdmin(async (q) => (await q<{ plan_key: string }>("select plan_key from public.subscriptions where organization_id = $1", [org])).rows[0].plan_key)).toBe("basic");

    const suspend = (userId: string) => asMfaUser(userId, (q) => q("select public.platform_set_org_status($1, 'suspended', 'בדיקה')", [org]));
    expect((await pgError(suspend(finance.id))).code).toBe("42501");
    await suspend(pOwner.id);
    await asMfaUser(pOwner.id, (q) => q("select public.platform_set_org_status($1, 'trial', 'שחזור')", [org]));

    expect((await pgError(asMfaUser(pOwner.id, (q) => q("select public.platform_set_org_status($1, 'suspended', '  ')", [org])))).code).toBe("22023");
    const badOverride = await pgError(
      asMfaUser(pOwner.id, (q) => q("select public.platform_set_overrides($1, '{\"max_users\": \"lots\"}', '{}', 'x')", [org])),
    );
    expect(badOverride.code).toBe("22023");
    await asMfaUser(pOwner.id, (q) => q("select public.platform_set_overrides($1, '{\"max_users\": 50}', '{\"sso\": true}', 'לקוח גדול')", [org]));
    expect(await asAdmin(async (q) => (await q<{ ok: boolean }>("select app.org_has_feature($1, 'sso') as ok", [org])).rows[0].ok)).toBe(true);

    const log = await asMfaUser(readonly.id, async (q) => (await q<{ r: Array<{ action: string }> }>("select public.platform_log_list($1) as r", [org])).rows[0].r);
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["subscription.update", "organization.status", "subscription.overrides"]));
    // even the database owner cannot rewrite history
    expect((await pgError(asAdmin((q) => q("delete from app.platform_log")))).code).toBe("42501");
    expect((await pgError(asAdmin((q) => q("update app.platform_log set action = 'x'")))).code).toBe("42501");
  });

  it("platform staff see no customer records until the customer grants support access", async () => {
    const leads = (userId: string, mfa = true) =>
      (mfa ? asMfaUser : asUser)(userId, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]));
    expect(await leads(support.id)).toBe(0);
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org])))).hint).toBe("platform:no_grant");

    // a member cannot grant; an admin can, for up to 7 days
    expect((await pgError(asUser(member.id, (q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org])))).code).toBe("42501");
    expect((await pgError(asUser(admin.id, (q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '8 days')", [org])))).code).toBe("23514");
    const grant = await asUser(admin.id, async (q) =>
      (await q<{ id: string }>("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '2 hours') returning id", [org])).rows[0].id,
    );

    // the approval alone gives no read: support opens a session, which is logged (FXS-08)
    expect(await leads(support.id)).toBe(0);
    await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org]));
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and action = 'support_open'", [org]))).toBe(1);
    expect(await leads(support.id)).toBeGreaterThan(0);
    expect(await leads(support.id, false)).toBe(0); // no second factor, no access
    expect(await leads(finance.id)).toBe(0); // not a support role

    // read-only: no inserts, no updates, no deletes
    expect((await pgError(insertLead(support.id, org))).code).toBe("42501");
    await asMfaUser(support.id, async (q) => {
      expect((await q("update public.leads set full_name = 'x' where organization_id = $1", [org])).rowCount).toBe(0);
      expect((await q("update public.organizations set name = 'x' where id = $1", [org])).rowCount).toBe(0);
      expect((await pgError(q("select public.create_invitation($1, 'x@example.test', 'admin')", [org]))).code).toBe("42501");
    });

    // the customer revokes: access ends at once
    await asUser(admin.id, (q) => q("update public.support_access_grants set revoked_at = now() where id = $1", [grant]));
    expect(await leads(support.id)).toBe(0);
  });

  it("plans and the team are the platform owner's", async () => {
    const editPlan = (userId: string, monthly = 7900, annual = 6900) =>
      asMfaUser(userId, (q) =>
        q(
          "select public.platform_update_plan('basic', 'בסיס', $1, $2, (select limits from public.plans where key = 'basic'), (select features from public.plans where key = 'basic'), true)",
          [monthly, annual],
        ),
      );
    expect((await pgError(editPlan(finance.id))).code).toBe("42501");
    await editPlan(pOwner.id);
    expect(await asAdmin(async (q) => (await q<{ p: number }>("select price_monthly_agorot as p from public.plans where key = 'basic'")).rows[0].p)).toBe(7900);
    // back to the owner's price (13 October 2026), for the tests that read it later
    await editPlan(pOwner.id, 8900, 7900);

    expect((await pgError(asMfaUser(support.id, (q) => q("select public.platform_set_staff($1, 'owner')", [support.email])))).code).toBe("42501");
    await asMfaUser(pOwner.id, (q) => q("select public.platform_set_staff($1, 'readonly')", [member.email]));
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_staff where user_id = $1", [member.id]))).toBe(1);
    await asMfaUser(pOwner.id, (q) => q("select public.platform_set_staff($1, null)", [member.email]));
    const lastOwner = await pgError(asMfaUser(pOwner.id, (q) => q("select public.platform_set_staff($1, 'support')", [pOwner.email])));
    expect(lastOwner.hint).toBe("platform:last_owner");

    const metrics = await asMfaUser(readonly.id, async (q) => (await q<{ r: Record<string, unknown> }>("select public.platform_metrics() as r")).rows[0].r);
    expect(Number(metrics.orgs_total)).toBeGreaterThan(0);
    expect(metrics).toHaveProperty("mrr_agorot");
  });
});

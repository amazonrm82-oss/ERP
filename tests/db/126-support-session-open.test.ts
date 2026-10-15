import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";
import { MIGRATIONS_DIR, migrationFile } from "./rerun";

// FXS-08: the customer's approval alone gives platform support nothing. Opening the session (platform_open_support)
// is what gives the read, and it writes the platform log and the customer's audit log in the same transaction.

type U = { id: string; email: string };

const staffIds: string[] = [];
const makeStaff = async (label: string, role: string) => {
  const u = await createUser(label);
  staffIds.push(u.id);
  await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2)", [u.id, role]));
  return u;
};

afterAll(async () => {
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

describe("support access needs an opened session (FXS-08)", () => {
  let owner: U, admin: U, member: U, support: U, support2: U, pOwner: U, finance: U;
  let org: string, otherOrg: string, lead: string;

  const open = (userId: string, o = org) => asMfaUser(userId, (q) => q<{ until: string }>("select public.platform_open_support($1) as until", [o]));
  const leads = (userId: string, mfa = true, o = org) =>
    (mfa ? asMfaUser : asUser)(userId, (q) => count(q, "select 1 from public.leads where organization_id = $1", [o]));
  const state = (userId: string, o = org) =>
    asMfaUser(userId, async (q) => {
      const r = await q<{ session: boolean; role: string | null; info: { expires_at: string } | null; can_read: boolean }>(
        `select app.support_session($1) as session, app.role_in($1)::text as role, public.support_session_info($1) as info,
                app.can_read_record($1, null, null) as can_read`,
        [o],
      );
      return r.rows[0];
    });
  const logs = (action: string, actor: string, o = org) =>
    asAdmin(async (q) => ({
      platform: await count(q, "select 1 from app.platform_log where action = 'support.open' and organization_id = $1 and actor_id = $2", [o, actor]),
      audit: await count(q, "select 1 from public.audit_log where action = $3 and organization_id = $1 and actor_id = $2", [o, actor, action]),
    }));
  const grant = (hours = 1, o = org) =>
    asUser(admin.id, async (q) =>
      (
        await q<{ id: string; expires_at: string }>(
          "insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + make_interval(hours => $2)) returning id, expires_at",
          [o, hours],
        )
      ).rows[0],
    );
  const revokeAll = () => asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1 and revoked_at is null", [org]));

  beforeAll(async () => {
    owner = await createUser("fxs08-owner");
    org = await createOrg(owner.id, "עסק תמיכה");
    admin = await addMember(org, owner.id, "admin", "fxs08-admin");
    member = await addMember(org, owner.id, "member", "fxs08-member");
    lead = await insertLead(owner.id, org, { full_name: "ליד לתמיכה" });
    const otherOwner = await createUser("fxs08-other");
    otherOrg = await createOrg(otherOwner.id, "עסק אחר");
    support = await makeStaff("fxs08-support", "support");
    support2 = await makeStaff("fxs08-support2", "support");
    pOwner = await makeStaff("fxs08-powner", "owner");
    finance = await makeStaff("fxs08-finance", "finance");
  });

  it("an approval without an opened session gives no read", async () => {
    const g = await grant();
    try {
      for (const u of [support, pOwner]) {
        expect(await leads(u.id), u.email).toBe(0);
        expect(await asMfaUser(u.id, (q) => count(q, "select 1 from public.organizations where id = $1", [org])), u.email).toBe(0);
        expect(await state(u.id), u.email).toEqual({ session: false, role: null, info: null, can_read: false });
      }
      // nothing was logged, because nothing was read
      expect(await logs("support_open", support.id)).toEqual({ platform: 0, audit: 0 });
      // the approval row is still there and live
      expect(await asAdmin((q) => count(q, "select 1 from public.support_access_grants where id = $1 and revoked_at is null and expires_at > now()", [g.id]))).toBe(1);
    } finally {
      await revokeAll();
    }
  });

  it("opening the session gives a read-only read and logs exactly once", async () => {
    const g = await grant(2);
    try {
      const until = (await open(support.id)).rows[0].until;
      expect(new Date(until).getTime()).toBe(new Date(g.expires_at).getTime());
      expect(await logs("support_open", support.id)).toEqual({ platform: 1, audit: 1 });
      const st = await state(support.id);
      expect({ ...st, info: null }).toEqual({ session: true, role: "viewer", info: null, can_read: true });
      expect(new Date(st.info!.expires_at).getTime()).toBe(new Date(g.expires_at).getTime());
      expect(await leads(support.id)).toBe(1);

      // opening again under the same approval (a page reload, a second click) logs nothing more
      await open(support.id);
      await open(support.id);
      expect(await logs("support_open", support.id)).toEqual({ platform: 1, audit: 1 });
      expect(await asAdmin((q) => count(q, "select 1 from app.support_sessions where grant_id = $1", [g.id]))).toBe(1);

      // still read-only
      expect((await pgError(insertLead(support.id, org))).code).toBe("42501");
      expect(await asMfaUser(support.id, async (q) => (await q("update public.leads set full_name = 'x' where id = $1", [lead])).rowCount)).toBe(0);

      // the session is the caller's own: another support person, and the platform owner, still read nothing
      for (const u of [support2, pOwner]) {
        expect(await leads(u.id), u.email).toBe(0);
        expect((await state(u.id)).session, u.email).toBe(false);
      }
      // until they open their own, which is logged under their name
      await open(support2.id);
      expect(await leads(support2.id)).toBe(1);
      expect(await logs("support_open", support2.id)).toEqual({ platform: 1, audit: 1 });
      expect(await logs("support_open", support.id)).toEqual({ platform: 1, audit: 1 });

      // without the second factor the session gives nothing, and no one can open one
      expect(await leads(support.id, false)).toBe(0);
      expect((await pgError(asUser(support.id, (q) => q("select public.platform_open_support($1)", [org])))).code).toBe("42501");
      // finance is not a support role; a customer member is not platform staff
      expect((await pgError(open(finance.id))).code).toBe("42501");
      expect((await pgError(open(member.id))).code).toBe("42501");
      expect(await leads(finance.id)).toBe(0);
      // a session in one business opens nothing in another
      expect(await leads(support.id, true, otherOrg)).toBe(0);
      expect((await pgError(open(support.id, otherOrg))).hint).toBe("platform:no_grant");
      expect(await logs("support_open", support.id, otherOrg)).toEqual({ platform: 0, audit: 0 });

      // members are unaffected
      expect(await asUser(member.id, (q) => count(q, "select 1 from public.leads where organization_id = $1", [org]))).toBe(1);
    } finally {
      await revokeAll();
    }
  });

  it("the customer's revoke or the approval's end closes the session; a new approval needs a new, logged open", async () => {
    const g = await grant();
    await open(support.id);
    expect(await leads(support.id)).toBe(1);
    const before = await logs("support_open", support.id);

    await asUser(admin.id, (q) => q("update public.support_access_grants set revoked_at = now() where id = $1", [g.id]));
    expect(await leads(support.id)).toBe(0);
    expect(await state(support.id)).toEqual({ session: false, role: null, info: null, can_read: false });
    expect((await pgError(open(support.id))).hint).toBe("platform:no_grant");

    // a new approval: the old session does not carry over
    await grant();
    expect(await leads(support.id)).toBe(0);
    await open(support.id);
    expect(await leads(support.id)).toBe(1);
    expect(await logs("support_open", support.id)).toEqual({ platform: before.platform + 1, audit: before.audit + 1 });

    await revokeAll();

    // the approval ends by time: a session row under an ended approval gives nothing (the row is made by hand here,
    // because touch_row keeps created_at and the check keeps expires_at after it)
    await asAdmin(async (q) => {
      const ended = (
        await q<{ id: string }>(
          "insert into public.support_access_grants (organization_id, created_at, expires_at) values ($1, now() - interval '2 hours', now() - interval '1 hour') returning id",
          [org],
        )
      ).rows[0].id;
      await q("insert into app.support_sessions (organization_id, grant_id, staff_user_id) values ($1, $2, $3)", [org, ended, support.id]);
    });
    expect(await leads(support.id)).toBe(0);
    expect(await state(support.id)).toEqual({ session: false, role: null, info: null, can_read: false });
    expect((await pgError(open(support.id))).hint).toBe("platform:no_grant");
  });

  it("with two live approvals the session follows the one it was opened under", async () => {
    const short = await grant(1);
    const long = await grant(3);
    try {
      const until = (await open(support.id)).rows[0].until;
      expect(new Date(until).getTime()).toBe(new Date(long.expires_at).getTime());
      // revoking the approval the session was not opened under changes nothing
      await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where id = $1", [short.id]));
      expect(await leads(support.id)).toBe(1);
      await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where id = $1", [long.id]));
      expect(await leads(support.id)).toBe(0);
    } finally {
      await revokeAll();
    }
  });

  it("the sessions table is closed to clients", async () => {
    for (const run of [
      (sql: string, p: unknown[]) => asUser(admin.id, (q) => q(sql, p)),
      (sql: string, p: unknown[]) => asMfaUser(support.id, (q) => q(sql, p)),
      (sql: string, p: unknown[]) => asAnon((q) => q(sql, p)),
    ]) {
      expect((await pgError(run("select 1 from app.support_sessions", []))).code).toBe("42501");
    }
    const g = await grant();
    try {
      expect(
        (await pgError(asMfaUser(support.id, (q) =>
          q("insert into app.support_sessions (organization_id, grant_id, staff_user_id) values ($1, $2, $3)", [org, g.id, support.id]),
        ))).code,
      ).toBe("42501");
      expect(await leads(support.id)).toBe(0);
    } finally {
      await revokeAll();
    }
    // the functions keep their grants: open and info for authenticated only
    const acl = await asAdmin(async (q) =>
      (
        await q<{ fn: string; anon: boolean; auth: boolean }>(
          `select p.proname as fn, has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where (n.nspname, p.proname) in (('public', 'platform_open_support'), ('public', 'support_session_info'), ('app', 'support_session'))
            order by 1`,
        )
      ).rows,
    );
    expect(acl).toEqual([
      { fn: "platform_open_support", anon: false, auth: true },
      { fn: "support_session", anon: false, auth: true },
      { fn: "support_session_info", anon: false, auth: true },
    ]);
  });

  it("the migration is safe to run twice and keeps open sessions", async () => {
    const g = await grant();
    try {
      await open(support.id);
      const sql = readFileSync(join(MIGRATIONS_DIR, migrationFile("_support_session_open.sql")), "utf8");
      await asAdmin((q) => q(sql));
      await asAdmin((q) => q(sql));
      expect(await asAdmin((q) => count(q, "select 1 from app.support_sessions where grant_id = $1", [g.id]))).toBe(1);
      expect(await leads(support.id)).toBe(1);
      expect(await leads(support2.id)).toBe(0);
    } finally {
      await revokeAll();
    }
  });
});

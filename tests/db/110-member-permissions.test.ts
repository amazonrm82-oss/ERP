import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEMBER_PERMISSION_KEYS } from "@/features/permissions/keys";

import { addMember, asAdmin, asMfaUser, asUser, closePool, count, createOrg, createUser, insertLead, pgError } from "./helpers";

type U = { id: string; email: string };

const staffIds: string[] = [];
afterAll(async () => {
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

// PRM-01: individual permissions on top of the role. Each widened gate is checked for a member
// with the grant, a member without it, the same grant in another business, and a viewer.
describe("member permissions (PRM-01)", () => {
  let owner: U, admin: U, manager: U, member: U, plain: U, viewer: U, owner2: U, other: U, support: U;
  let org: string, org2: string;

  const grant = (by: string, user: string, keys: string[], o = org) =>
    asUser(by, async (q) => (await q<{ k: string[] }>("select public.set_member_permissions($1, $2, $3) as k", [o, user, keys])).rows[0].k);
  const stored = (user: string, o = org) =>
    asAdmin(async (q) => (await q<{ p: string[] }>("select permissions as p from public.member_permissions where organization_id = $1 and user_id = $2", [o, user])).rows[0]?.p ?? null);
  const mine = (user: string, o = org) =>
    asUser(user, async (q) => (await q<{ k: string[] }>("select public.my_permissions($1) as k", [o])).rows[0].k);
  const setFlag = (on: boolean | null, o = org) =>
    asAdmin((q) =>
      q("update public.subscriptions set feature_overrides = case when $2::boolean is null then feature_overrides - 'granular_permissions' else feature_overrides || jsonb_build_object('granular_permissions', $2::boolean) end where organization_id = $1", [o, on]),
    );

  beforeAll(async () => {
    owner = await createUser("prm-owner");
    org = await createOrg(owner.id, "עסק הרשאות");
    admin = await addMember(org, owner.id, "admin", "prm-admin");
    manager = await addMember(org, owner.id, "manager", "prm-manager");
    member = await addMember(org, owner.id, "member", "prm-member");
    plain = await addMember(org, owner.id, "member", "prm-plain");
    viewer = await addMember(org, owner.id, "viewer", "prm-viewer");
    owner2 = await createUser("prm-owner2");
    org2 = await createOrg(owner2.id, "עסק שני");
    other = await addMember(org2, owner2.id, "member", "prm-other");
    support = await createUser("prm-support");
    staffIds.push(support.id);
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]));
  });

  it("the closed list matches the app, and the table refuses anything else", async () => {
    const keys = await asAdmin(async (q) => (await q<{ k: string[] }>("select app.member_permission_keys() as k")).rows[0].k);
    expect([...keys].sort()).toEqual([...MEMBER_PERMISSION_KEYS].sort());
    const def = await asAdmin(async (q) => (await q<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'member_permissions_known'")).rows[0].d);
    expect([...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort()).toEqual([...MEMBER_PERMISSION_KEYS].sort());
    expect((await pgError(asAdmin((q) => q("insert into public.member_permissions (organization_id, user_id, permissions) values ($1, $2, '{fly}')", [org, plain.id])))).code).toBe("23514");
  });

  it("owners and admins grant; nobody else does; the target must be an active manager or member", async () => {
    expect(await grant(owner.id, member.id, ["export", "import", "export"])).toEqual(["export", "import"]);
    expect(await grant(admin.id, manager.id, ["edit_catalog"])).toEqual(["edit_catalog"]);
    expect(await stored(member.id)).toEqual(["export", "import"]);
    for (const u of [manager, member, plain, viewer]) {
      expect((await pgError(grant(u.id, plain.id, ["export"]))).code, u.email).toBe("42501");
    }
    // another business's owner, and platform support in a customer-approved session
    expect((await pgError(grant(owner2.id, plain.id, ["export"]))).code).toBe("42501");
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]));
    expect((await pgError(asMfaUser(support.id, (q) => q("select public.set_member_permissions($1, $2, '{export}')", [org, plain.id])))).code).toBe("42501");
    expect(await asMfaUser(support.id, async (q) => (await q<{ k: string[] }>("select public.my_permissions($1) as k", [org])).rows[0].k)).toEqual([]);
    await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [org]));
    // a user of another business cannot be targeted
    expect((await pgError(grant(owner.id, other.id, ["export"]))).code).toBe("P0002");
    for (const u of [owner, admin, viewer]) {
      expect((await pgError(grant(owner.id, u.id, ["export"]))).hint, u.email).toBe("permissions:role");
    }
    expect((await pgError(grant(owner.id, plain.id, ["fly"]))).hint).toBe("permissions:invalid");
    expect((await pgError(grant(owner.id, plain.id, [null as unknown as string]))).hint).toBe("permissions:invalid");
    // removing everything from someone with no row makes no row
    expect(await grant(owner.id, plain.id, [])).toEqual([]);
    expect(await stored(plain.id)).toBeNull();
    // clients never write the table directly
    await asUser(owner.id, async (q) => {
      expect((await pgError(q("insert into public.member_permissions (organization_id, user_id, permissions) values ($1, $2, '{export}')", [org, plain.id]))).code).toBe("42501");
    });
    expect((await pgError(asUser(owner.id, (q) => q("update public.member_permissions set permissions = '{}' where organization_id = $1", [org])))).code).toBe("42501");
    expect((await pgError(asUser(owner.id, (q) => q("delete from public.member_permissions where organization_id = $1", [org])))).code).toBe("42501");
  });

  it("everyone reads their own row; owners and admins read all; another business nothing", async () => {
    await asUser(member.id, async (q) => {
      expect(await count(q, "select 1 from public.member_permissions where organization_id = $1", [org])).toBe(1);
    });
    await asUser(manager.id, async (q) => {
      expect(await count(q, "select 1 from public.member_permissions where organization_id = $1 and user_id = $2", [org, member.id])).toBe(0);
    });
    for (const u of [owner, admin]) {
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.member_permissions where organization_id = $1", [org]))).toBe(2);
    }
    expect(await asUser(owner2.id, (q) => count(q, "select 1 from public.member_permissions where organization_id = $1", [org]))).toBe(0);
  });

  it("every change is in the audit log with the user and the keys", async () => {
    await grant(owner.id, member.id, ["export", "import", "manage_automations"]);
    const entry = await asAdmin(async (q) =>
      (await q<{ actor_id: string; changes: { user_id: string; permissions: { old: string[]; new: string[] } } }>(
        "select actor_id, changes from public.audit_log where organization_id = $1 and entity_type = 'member_permissions' order by created_at desc, id desc limit 1",
        [org],
      )).rows[0],
    );
    expect(entry.actor_id).toBe(owner.id);
    expect(entry.changes).toEqual({ user_id: member.id, permissions: { old: ["export", "import"], new: ["export", "import", "manage_automations"] } });
    // the same keys again write nothing
    const before = await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'member_permissions'", [org]));
    await grant(owner.id, member.id, ["manage_automations", "import", "export"]);
    expect(await asAdmin((q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'member_permissions'", [org]))).toBe(before);
  });

  it("my_permissions: all for owners and admins, the granted ones for others, none for a viewer", async () => {
    expect(await mine(owner.id)).toEqual([...MEMBER_PERMISSION_KEYS].sort());
    expect(await mine(admin.id)).toEqual([...MEMBER_PERMISSION_KEYS].sort());
    expect(await mine(member.id)).toEqual(["export", "import", "manage_automations"]);
    expect(await mine(plain.id)).toEqual([]);
    expect(await mine(viewer.id)).toEqual([]);
    expect(await mine(other.id)).toEqual([]);
  });

  it("export: the grant lets a member log a list or report export; the full export stays the owner's", async () => {
    const list = (u: string, o = org) => asUser(u, (q) => q("select public.log_list_export($1, 'lead', 'csv', 3, 'filtered', '{}')", [o]));
    const report = (u: string, o = org) => asUser(u, (q) => q("select public.log_export($1, 'report', 'sources', 3, 'csv')", [o]));
    await list(member.id);
    await report(member.id);
    for (const u of [plain, viewer]) {
      expect((await pgError(list(u.id))).code, u.email).toBe("42501");
      expect((await pgError(report(u.id))).code, u.email).toBe("42501");
    }
    // the grant does not reach another business
    expect((await pgError(list(member.id, org2))).code).toBe("42501");
    expect((await pgError(asUser(member.id, (q) => q("select public.log_export($1, 'full', null, 3)", [org])))).code).toBe("42501");
    // a viewer given the key behind the function's back still holds nothing
    await asAdmin((q) => q("insert into public.member_permissions (organization_id, user_id, permissions) values ($1, $2, '{export,import,edit_catalog,manage_automations}')", [org, viewer.id]));
    expect((await pgError(list(viewer.id))).code).toBe("42501");
    expect(await mine(viewer.id)).toEqual([]);
  });

  it("import: the grant lets a member start an import of their own", async () => {
    const start = (u: string, o = org) =>
      asUser(u, async (q) => (await q<{ id: string }>("insert into public.import_jobs (organization_id, entity_type, file_name, duplicate_mode) values ($1, 'lead', 'x.csv', 'skip') returning id", [o])).rows[0].id);
    const job = await start(member.id);
    await asUser(member.id, async (q) => {
      expect((await q("update public.import_jobs set status = 'done' where id = $1", [job])).rowCount).toBe(1);
    });
    for (const u of [plain, viewer]) {
      expect((await pgError(start(u.id))).code, u.email).toBe("42501");
    }
    expect((await pgError(start(member.id, org2))).code).toBe("42501");
    // products are part of the catalog: the import grant alone does not write them
    expect((await pgError(asUser(member.id, (q) => q("insert into public.products (organization_id, name) values ($1, 'x')", [org])))).code).toBe("42501");
  });

  it("catalog: the grant writes products, categories, units, price lists and their lines, within the quota", async () => {
    const product = await asUser(manager.id, async (q) => (await q<{ id: string }>("insert into public.products (organization_id, name) values ($1, 'מוצר של מנהל') returning id", [org])).rows[0].id);
    await asUser(manager.id, async (q) => {
      expect((await q("update public.products set price_agorot = 100 where id = $1", [product])).rowCount).toBe(1);
      const category = (await q<{ id: string }>("insert into public.product_categories (organization_id, name) values ($1, 'קטגוריה') returning id", [org])).rows[0].id;
      expect((await q("update public.product_categories set name = 'קטגוריה 2' where id = $1", [category])).rowCount).toBe(1);
      expect((await q("delete from public.product_categories where id = $1", [category])).rowCount).toBe(1);
      const unit = (await q<{ id: string }>("insert into public.product_units (organization_id, name) values ($1, 'ארגז') returning id", [org])).rows[0].id;
      expect((await q("update public.product_units set name = 'ארגז גדול' where id = $1", [unit])).rowCount).toBe(1);
      expect((await q("delete from public.product_units where id = $1", [unit])).rowCount).toBe(1);
      const list = (await q<{ id: string }>("insert into public.price_lists (organization_id, name) values ($1, 'סיטונאים') returning id", [org])).rows[0].id;
      const line = (await q<{ id: string }>("insert into public.price_list_lines (organization_id, price_list_id, product_id, discount_bp) values ($1, $2, $3, 500) returning id", [org, list, product])).rows[0].id;
      expect((await q("update public.price_list_lines set discount_bp = 600 where id = $1", [line])).rowCount).toBe(1);
      expect((await q("delete from public.price_list_lines where id = $1", [line])).rowCount).toBe(1);
      expect((await q("update public.price_lists set name = 'סיטונאים 2' where id = $1", [list])).rowCount).toBe(1);
      expect((await q("delete from public.price_lists where id = $1", [list])).rowCount).toBe(1);
    });
    for (const u of [plain, viewer, member]) {
      await asUser(u.id, async (q) => {
        expect((await q("update public.products set name = 'x' where id = $1", [product])).rowCount, u.email).toBe(0);
        expect((await q("delete from public.products where id = $1", [product])).rowCount, u.email).toBe(0);
      });
      for (const sql of [
        "insert into public.products (organization_id, name) values ($1, 'x')",
        "insert into public.product_categories (organization_id, name) values ($1, 'x')",
        "insert into public.product_units (organization_id, name) values ($1, 'x')",
        "insert into public.price_lists (organization_id, name) values ($1, 'x')",
      ]) {
        expect((await pgError(asUser(u.id, (q) => q(sql, [org])))).code, `${u.email}: ${sql}`).toBe("42501");
      }
    }
    // the grant does not reach another business, and tells it nothing about that business's plan
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = limit_overrides || '{\"max_products\": 0}' where organization_id = $1", [org2]));
    await asAdmin((q) => q("insert into public.memberships (organization_id, user_id, role, seat_type) values ($1, $2, 'member', 'full')", [org2, manager.id]));
    const outside = await pgError(asUser(manager.id, (q) => q("insert into public.products (organization_id, name) values ($1, 'x')", [org2])));
    expect(outside.code).toBe("42501");
    expect(outside.hint ?? null).toBeNull();
    // a grant holder is counted against the quota like an admin
    const used = await asAdmin((q) => count(q, "select 1 from public.products where organization_id = $1", [org]));
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = limit_overrides || jsonb_build_object('max_products', $2::int) where organization_id = $1", [org, used]));
    expect((await pgError(asUser(manager.id, (q) => q("insert into public.products (organization_id, name) values ($1, 'one too many')", [org])))).hint).toBe("limit:max_products");
    await asAdmin((q) => q("update public.subscriptions set limit_overrides = limit_overrides - 'max_products' where organization_id = $1", [org]));
  });

  it("automations: the grant reads, writes and test-runs rules; a test run needs a record the person reads", async () => {
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    const rule = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.automations (organization_id, name, entity_type, trigger_type, actions, is_active) values ($1, 'כלל', 'lead', 'created', '[{\"type\":\"notify\"}]', false) returning id", [org])).rows[0].id,
    );
    await asUser(member.id, async (q) => {
      expect(await count(q, "select 1 from public.automations where id = $1", [rule])).toBe(1);
      expect((await q("update public.automations set name = 'כלל 2' where id = $1", [rule])).rowCount).toBe(1);
    });
    const ownLead = await insertLead(member.id, org, { full_name: "ליד של החבר" });
    const hiddenLead = await insertLead(plain.id, org, { full_name: "ליד של אחר" });
    const run = await asUser(member.id, async (q) => (await q<{ r: { status: string } }>("select public.run_automation_now($1, $2) as r", [rule, ownLead])).rows[0].r);
    expect(run.status).toBeDefined();
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.automation_runs where automation_id = $1", [rule]))).toBeGreaterThan(0);
    expect((await pgError(asUser(member.id, (q) => q("select public.run_automation_now($1, $2)", [rule, hiddenLead])))).code).toBe("P0002");
    // an admin test-runs on any record
    await asUser(admin.id, (q) => q("select public.run_automation_now($1, $2)", [rule, hiddenLead]));
    for (const u of [plain, viewer, manager]) {
      await asUser(u.id, async (q) => {
        expect(await count(q, "select 1 from public.automations where id = $1", [rule]), u.email).toBe(0);
        expect(await count(q, "select 1 from public.automation_runs where automation_id = $1", [rule]), u.email).toBe(0);
        expect((await q("update public.automations set name = 'x' where id = $1", [rule])).rowCount, u.email).toBe(0);
        expect((await q("delete from public.automations where id = $1", [rule])).rowCount, u.email).toBe(0);
      });
      expect((await pgError(asUser(u.id, (q) => q("select public.run_automation_now($1, $2)", [rule, ownLead])))).code, u.email).toBe("P0002");
      expect((await pgError(asUser(u.id, (q) => q("insert into public.automations (organization_id, name, entity_type, trigger_type, actions) values ($1, 'x', 'lead', 'created', '[{\"type\":\"notify\"}]')", [org])))).code, u.email).toBe("42501");
    }
    await asUser(member.id, async (q) => {
      expect((await q("delete from public.automations where id = $1", [rule])).rowCount).toBe(1);
    });
    await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
  });

  it("without the plan capability the grants do nothing and none can be added; removing still works", async () => {
    await setFlag(false);
    expect(await mine(member.id)).toEqual([]);
    expect((await pgError(asUser(member.id, (q) => q("select public.log_list_export($1, 'lead', 'csv', 3, 'filtered', '{}')", [org])))).code).toBe("42501");
    expect((await pgError(grant(owner.id, member.id, ["export", "import", "manage_automations", "edit_catalog"]))).hint).toBe("feature:granular_permissions");
    expect(await grant(owner.id, member.id, ["export", "import"])).toEqual(["export", "import"]);
    await setFlag(null);
    expect(await mine(member.id)).toEqual(["export", "import"]);
  });

  it("suspension, a role change and removal take the grants away; a return starts from nothing", async () => {
    await grant(owner.id, plain.id, ["export"]);
    await asUser(owner.id, (q) => q("update public.memberships set status = 'suspended' where organization_id = $1 and user_id = $2", [org, plain.id]));
    expect(await stored(plain.id)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.memberships set status = 'active' where organization_id = $1 and user_id = $2", [org, plain.id]));
    expect(await mine(plain.id)).toEqual([]);

    await grant(owner.id, plain.id, ["import"]);
    await asUser(owner.id, (q) => q("update public.memberships set role = 'admin' where organization_id = $1 and user_id = $2", [org, plain.id]));
    expect(await stored(plain.id)).toEqual([]);
    await asUser(owner.id, (q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, plain.id]));

    // a manager made a member keeps the grants (both hold them)
    await grant(owner.id, manager.id, ["edit_catalog", "export"]);
    await asUser(owner.id, (q) => q("update public.memberships set role = 'member' where organization_id = $1 and user_id = $2", [org, manager.id]));
    expect(await stored(manager.id)).toEqual(["edit_catalog", "export"]);

    // a removed member (owns no records here) loses the row with the membership
    const leaver = await addMember(org, owner.id, "member", "prm-leaver");
    await grant(owner.id, leaver.id, ["export"]);
    await asAdmin((q) => q("delete from public.memberships where organization_id = $1 and user_id = $2", [org, leaver.id]));
    expect(await stored(leaver.id)).toBeNull();
    const removal = await asAdmin(async (q) =>
      (await q<{ action: string; changes: { permissions: { new: string[] } } }>(
        "select action, changes from public.audit_log where organization_id = $1 and entity_type = 'member_permissions' and changes ->> 'user_id' = $2 order by created_at desc, id desc limit 1",
        [org, leaver.id],
      )).rows[0],
    );
    expect(removal).toMatchObject({ action: "delete", changes: { permissions: { new: [] } } });
  });
});

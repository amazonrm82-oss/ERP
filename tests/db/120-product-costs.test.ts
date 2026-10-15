import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

type U = { id: string; email: string };

const staffIds: string[] = [];
afterAll(async () => {
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

// PRD-06: everyone reads the catalog; the cost of a product is kept in its own table and only owners,
// admins, managers (role) and holders of the PRM-01 grant view_costs get it, in any read of the
// database. Writing it also needs the catalog rule (admins or the edit_catalog grant).
describe("product cost and who sees it (PRD-06)", () => {
  let owner: U, admin: U, manager: U, member: U, editor: U, costEditor: U, costViewer: U, viewer: U, support: U, owner2: U;
  let org: string, product: string, spare: string;

  const grant = (user: string, keys: string[]) => asUser(owner.id, (q) => q("select public.set_member_permissions($1, $2, $3)", [org, user, keys]));
  const setFlag = (key: string, on: boolean | null, o = org) =>
    asAdmin((q) =>
      q(
        "update public.subscriptions set feature_overrides = case when $3::boolean is null then feature_overrides - $2 else feature_overrides || jsonb_build_object($2, $3::boolean) end where organization_id = $1",
        [o, key, on],
      ),
    );
  const costsSeen = (user: string, o = org) => asUser(user, (q) => count(q, "select 1 from public.product_costs where organization_id = $1", [o]));
  const canView = (user: string, o = org) =>
    asUser(user, async (q) => (await q<{ v: boolean }>("select app.can_view_costs($1) as v", [o])).rows[0].v);
  const setCost = (user: string, productId: string, agorot: number) =>
    asUser(user, (q) =>
      q(
        "insert into public.product_costs (organization_id, product_id, cost_agorot) values ($1, $2, $3) on conflict (organization_id, product_id) do update set cost_agorot = excluded.cost_agorot",
        [org, productId, agorot],
      ),
    );

  beforeAll(async () => {
    owner = await createUser("cost-owner");
    org = await createOrg(owner.id, "עסק עלויות");
    admin = await addMember(org, owner.id, "admin", "cost-admin");
    manager = await addMember(org, owner.id, "manager", "cost-manager");
    member = await addMember(org, owner.id, "member", "cost-member");
    editor = await addMember(org, owner.id, "member", "cost-editor");
    costEditor = await addMember(org, owner.id, "member", "cost-cost-editor");
    costViewer = await addMember(org, owner.id, "member", "cost-viewer-grant");
    viewer = await addMember(org, owner.id, "viewer", "cost-viewer");
    owner2 = await createUser("cost-owner2");
    await createOrg(owner2.id, "עסק אחר");
    support = await createUser("cost-support");
    staffIds.push(support.id);
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'support') on conflict (user_id) do update set role = excluded.role", [support.id]));
    await setFlag("granular_permissions", true);
    await grant(editor.id, ["edit_catalog"]);
    await grant(costEditor.id, ["edit_catalog", "view_costs"]);
    await grant(costViewer.id, ["view_costs"]);
    [product, spare] = await asUser(owner.id, async (q) => [
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, 'כיסא', 10000) returning id", [org])).rows[0].id,
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, 'שולחן', 50000) returning id", [org])).rows[0].id,
    ]);
    await setCost(owner.id, product, 6000);
  });

  it("the cost permission can be granted now", async () => {
    const built = await asAdmin(async (q) => (await q<{ k: string[] }>("select app.member_permission_built_keys() as k")).rows[0].k);
    expect(built).toContain("view_costs");
  });

  it("owners, admins, managers and the grant read the cost; members, editors without it and viewers get nothing", async () => {
    for (const u of [owner, admin, manager, costEditor, costViewer]) {
      expect(await costsSeen(u.id), u.email).toBe(1);
      expect(await canView(u.id), u.email).toBe(true);
    }
    for (const u of [member, editor, viewer]) {
      expect(await costsSeen(u.id), u.email).toBe(0);
      expect(await canView(u.id), u.email).toBe(false);
      // a direct read by id comes back empty too
      expect(await asUser(u.id, (q) => count(q, "select 1 from public.product_costs where product_id = $1", [product])), u.email).toBe(0);
    }
    // everyone still reads the product itself, and it carries no cost
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.products where id = $1", [product]))).toBe(1);
    const productColumns = await asAdmin(async (q) =>
      (await q<{ c: string }>("select column_name as c from information_schema.columns where table_schema = 'public' and table_name = 'products'")).rows.map((r) => r.c),
    );
    expect(productColumns.filter((c) => /cost|margin|profit/.test(c))).toEqual([]);
  });

  it("the grant works only while the plan holds the capability; another business and anonymous visitors get nothing", async () => {
    await setFlag("granular_permissions", false);
    expect(await costsSeen(costViewer.id)).toBe(0);
    expect(await canView(costViewer.id)).toBe(false);
    // roles do not depend on the capability
    expect(await costsSeen(manager.id)).toBe(1);
    await setFlag("granular_permissions", true);
    expect(await costsSeen(costViewer.id)).toBe(1);
    expect(await costsSeen(owner2.id)).toBe(0);
    expect(await asUser(owner2.id, (q) => count(q, "select 1 from public.product_costs"))).toBe(0);
    expect(await canView(owner2.id)).toBe(false);
    expect((await pgError(asAnon((q) => q("select * from public.product_costs"))))?.code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select app.can_view_costs($1)", [org]))))?.code).toBe("42501");
  });

  it("platform support in a customer-approved session reads the catalog but not the cost", async () => {
    await asAdmin((q) => q("insert into public.support_access_grants (organization_id, expires_at) values ($1, now() + interval '1 hour')", [org]));
    try {
      expect(await asMfaUser(support.id, (q) => count(q, "select 1 from public.products where organization_id = $1", [org]))).toBeGreaterThan(0);
      expect(await asMfaUser(support.id, (q) => count(q, "select 1 from public.product_costs where organization_id = $1", [org]))).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.support_access_grants set revoked_at = now() where organization_id = $1", [org]));
    }
  });

  it("writing the cost needs both the cost and the catalog rules", async () => {
    // seeing is not editing: a manager and a holder of view_costs alone
    for (const u of [manager, costViewer]) {
      expect((await pgError(setCost(u.id, spare, 1))).code, u.email).toBe("42501");
      expect(await asUser(u.id, async (q) => (await q("update public.product_costs set cost_agorot = 1 where product_id = $1", [product])).rowCount), u.email).toBe(0);
      expect(await asUser(u.id, async (q) => (await q("delete from public.product_costs where product_id = $1", [product])).rowCount), u.email).toBe(0);
    }
    // editing the catalog is not seeing the cost: an editor cannot write it blind
    for (const u of [editor, member, viewer]) {
      expect((await pgError(setCost(u.id, spare, 1))).code, u.email).toBe("42501");
      expect(await asUser(u.id, async (q) => (await q("update public.product_costs set cost_agorot = 1").then((r) => r.rowCount))), u.email).toBe(0);
      expect(await asUser(u.id, async (q) => (await q("delete from public.product_costs").then((r) => r.rowCount))), u.email).toBe(0);
    }
    expect(await asAdmin(async (q) => (await q<{ c: string }>("select cost_agorot::text as c from public.product_costs where product_id = $1", [product])).rows[0].c)).toBe("6000");
    // both rules: an admin and a member with both grants
    await setCost(admin.id, spare, 30000);
    expect(await asUser(costEditor.id, async (q) => (await q("update public.product_costs set cost_agorot = 6500 where product_id = $1", [product])).rowCount)).toBe(1);
    expect(await asUser(costEditor.id, async (q) => (await q("delete from public.product_costs where product_id = $1", [spare])).rowCount)).toBe(1);
    // only the cost and its currency are writable after the insert
    expect((await pgError(asUser(admin.id, (q) => q("update public.product_costs set product_id = $2 where product_id = $1", [product, spare]))))?.code).toBe("42501");
    expect((await pgError(setCost(admin.id, spare, -1))).code).toBe("23514");
  });

  it("a read-only business or one whose plan has no products keeps the cost readable but closed for writing", async () => {
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await costsSeen(admin.id)).toBe(1);
      expect((await pgError(setCost(admin.id, spare, 1))).code).toBe("42501");
      expect(await asUser(admin.id, async (q) => (await q("update public.product_costs set cost_agorot = 1 where product_id = $1", [product])).rowCount)).toBe(0);
      expect(await asUser(admin.id, async (q) => (await q("delete from public.product_costs where product_id = $1", [product])).rowCount)).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = 'active' where id = $1", [org]));
    }
    await setFlag("products", false);
    try {
      expect((await pgError(setCost(admin.id, spare, 1))).code).toBe("42501");
    } finally {
      await setFlag("products", null);
    }
  });

  it("cost changes are in the audit log, which only owners and admins read", async () => {
    const entries = (user: string) => asUser(user, (q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'product_costs'", [org]));
    expect(await entries(admin.id)).toBeGreaterThan(0);
    for (const u of [manager, member, editor, costEditor]) expect(await entries(u.id), u.email).toBe(0);
  });

  it("no function or view hands the cost to someone the table would not", async () => {
    // a security definer function that reads product_costs would bypass its RLS; only security invoker ones may read it
    const definers = await asAdmin(async (q) =>
      (
        await q<{ f: string }>(
          `select p.oid::regprocedure::text as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.prosecdef and p.prosrc ilike '%product_costs%'`,
        )
      ).rows.map((r) => r.f),
    );
    expect(definers).toEqual([]);
    const views = await asAdmin(async (q) =>
      (await q<{ v: string }>("select table_schema || '.' || table_name as v from information_schema.view_table_usage where table_name = 'product_costs'")).rows.map((r) => r.v),
    );
    expect(views).toEqual([]);
  });

  it("removing a product that no line uses removes its cost", async () => {
    const lone = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot) values ($1, 'מנורה', 2000) returning id", [org])).rows[0].id,
    );
    await setCost(owner.id, lone, 900);
    expect(await asUser(owner.id, async (q) => (await q("delete from public.products where id = $1", [lone])).rowCount)).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.product_costs where product_id = $1", [lone]))).toBe(0);
  });
});

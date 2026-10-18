import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Client } from "pg";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError, TEST_DB_URL } from "./helpers";

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
    await asMfaUser(support.id, (q) => q("select public.platform_open_support($1)", [org]));
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
    // a security definer function that reads product_costs (or deal_line_costs, the copy kept on each deal line) would
    // bypass its RLS; only security invoker ones may read it. The one exception is the trigger that copies a product's
    // cost into deal_line_costs when a line is made (owner, PRD-06 answer 2: every line keeps a copy, whoever adds it):
    // it writes from one cost table into the other, which has the same select rule, and returns nothing. It may stay
    // only while it is a trigger function nobody can call.
    const definers = await asAdmin(async (q) =>
      (
        await q<{ f: string; trigger: boolean; callers: number }>(
          `select p.oid::regprocedure::text as f, p.prorettype = 'trigger'::regtype as trigger,
                  (select count(*)::int from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) as callers
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.prosecdef
              and (p.prosrc ilike '%product_costs%' or p.prosrc ilike '%deal_line_costs%')`,
        )
      ).rows,
    );
    expect(definers.filter((d) => d.f !== "app.deal_line_cost_snapshot()").map((d) => d.f)).toEqual([]);
    expect(definers.find((d) => d.f === "app.deal_line_cost_snapshot()")).toEqual({ f: "app.deal_line_cost_snapshot()", trigger: true, callers: 0 });
    // owner, 18 October 2026: the exception holds only while it runs from a trigger, returns nothing a caller could read, and no
    // client role may execute it
    const shape = await asAdmin(async (q) =>
      (
        await q<{ rettype: string; triggers: number }>(
          `select p.prorettype::regtype::text as rettype,
                  (select count(*)::int from pg_trigger t where t.tgfoid = p.oid and not t.tgisinternal) as triggers
             from pg_proc p where p.oid = 'app.deal_line_cost_snapshot()'::regprocedure`,
        )
      ).rows[0],
    );
    expect(shape).toEqual({ rettype: "trigger", triggers: 1 });
    // ...and only while its body is the reviewed one (independent review, 18 October 2026): the shape and grants above do not
    // stop a body that notifies, raises or writes the cost somewhere a rep reads it. ANY change to the body of
    // app.deal_line_cost_snapshot() must come with an edit of this constant, and that edit needs its own independent review
    // of the new body against the owner's four conditions (trigger only, no client may execute it, returns nothing, a rep
    // without view_costs cannot read the cost through it).
    const REVIEWED_BODY_MD5 = "420b330eb372406c64b845dbc62907cb";
    const body = await asAdmin(async (q) =>
      (await q<{ h: string }>("select md5(p.prosrc) as h from pg_proc p where p.oid = 'app.deal_line_cost_snapshot()'::regprocedure")).rows[0].h,
    );
    expect(body).toBe(REVIEWED_BODY_MD5);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const can = await asAdmin(async (q) =>
        role === "public"
          ? (await q<{ c: boolean }>("select exists (select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = 'app.deal_line_cost_snapshot()'::regprocedure and a.grantee = 0) as c")).rows[0].c
          : (await q<{ c: boolean }>("select has_function_privilege($1, 'app.deal_line_cost_snapshot()', 'execute') as c", [role])).rows[0].c,
      );
      expect(can, role).toBe(false);
    }
    const views = await asAdmin(async (q) =>
      (await q<{ v: string }>("select table_schema || '.' || table_name as v from information_schema.view_table_usage where table_name in ('product_costs', 'deal_line_costs')")).rows.map((r) => r.v),
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
  it("a rep without view_costs who adds a product line gets the copy made, and no way to read it (owner, 18 October 2026)", async () => {
    const pipe = await defaultPipeline(org);
    const open = pipe.stages.find((s) => s.kind === "open")!.id;
    // an amount of eight digits, which no timestamp (six-digit fractions) or price in this test can hold by chance
    await setCost(owner.id, product, 73195713);
    const catalog = await asAdmin(async (q) => (await q<{ c: string }>("select cost_agorot::text as c from public.product_costs where product_id = $1", [product])).rows[0].c);
    expect(catalog).toBe("73195713");
    // the rep's own connection, so every message the server sends it while the line is made is caught (a notice, warning or
    // anything lower that a changed trigger might raise with the cost in it)
    const messages: string[] = [];
    const rep = new Client({ connectionString: TEST_DB_URL });
    rep.on("notice", (n) => messages.push(JSON.stringify({ message: n.message, detail: n.detail, hint: n.hint, where: n.where })));
    await rep.connect();
    let deal = "";
    let line = "";
    let returned: Record<string, unknown> = {};
    let reread: unknown[] = [];
    try {
      await rep.query("begin");
      await rep.query("set local client_min_messages = debug5");
      await rep.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: member.id, role: "authenticated" })]);
      await rep.query("set local role authenticated");
      deal = (
        await rep.query<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה של נציג', $2, $3, $4) returning id",
          [org, pipe.pipelineId, open, member.id],
        )
      ).rows[0].id;
      const inserted = await rep.query<Record<string, unknown>>(
        "insert into public.deal_lines (organization_id, deal_id, product_id, description, quantity, unit_price_agorot, price_source) values ($1, $2, $3, 'שורה', 1, 10000, 'product') returning *",
        [org, deal, product],
      );
      line = String(inserted.rows[0].id);
      returned = inserted.rows[0];
      // RETURNING is built before the after-insert trigger runs, so the line is read again once the trigger is done
      reread = (await rep.query<{ j: unknown }>("select to_jsonb(l) as j from public.deal_lines l where l.id = $1", [line])).rows.map((r) => r.j);
      await rep.query("commit");
    } finally {
      await rep.end();
    }
    // the copy exists (the trigger made it, with the catalog cost)...
    expect(await asAdmin(async (q) => (await q<{ c: string }>("select cost_agorot::text as c from public.deal_line_costs where deal_line_id = $1", [line])).rows[0].c)).toBe(catalog);
    // ...but nothing the rep got back or can read carries it: not the inserted line, not the cost table, not the audit log
    expect(Object.keys(returned).some((k) => k.includes("cost"))).toBe(false);
    expect(JSON.stringify(returned)).not.toContain(`"${catalog}"`);
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.deal_line_costs where deal_line_id = $1", [line]))).toBe(0);
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.deal_line_costs where organization_id = $1", [org]))).toBe(0);
    expect(await asUser(member.id, (q) => count(q, "select 1 from public.audit_log where organization_id = $1 and entity_type = 'deal_line_costs'", [org]))).toBe(0);
    // the amount itself, not only the word: in the line as the rep reads it after the trigger ran (ids taken out, so a uuid
    // that happens to hold the digits is no false alarm), in what the server told the rep's session, and in the rep's
    // notifications
    const withoutIds = (value: unknown) => JSON.stringify(value).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");
    expect(reread).toHaveLength(1);
    expect(withoutIds(reread[0])).not.toContain(catalog);
    expect(withoutIds(reread[0])).not.toContain("cost");
    expect(withoutIds(returned)).not.toContain(catalog);
    expect(messages.filter((m) => m.includes(catalog))).toEqual([]);
    const told = await asAdmin(async (q) =>
      (await q<{ j: unknown }>("select to_jsonb(n) as j from public.notifications n where n.organization_id = $1 and n.user_id = $2", [org, member.id])).rows.map((r) =>
        withoutIds(r.j),
      ),
    );
    expect(told.filter((n) => n.includes(catalog))).toEqual([]);
    // and it cannot call the copying function itself
    const direct = await pgError(asUser(member.id, (q) => q("select app.deal_line_cost_snapshot()")));
    expect(["42501", "0A000", "42883"]).toContain(direct.code);
    expect(direct.message).not.toContain(catalog);
    void deal;
  });

  it("a deal line's kept cost is changed only by those who see costs and may edit the deal (PRD-06 follow-up)", async () => {
    const pipe = await defaultPipeline(org);
    const open = pipe.stages.find((s) => s.kind === "open")!.id;
    const dealOf = (user: string) =>
      asUser(user, async (q) =>
        (
          await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id) values ($1, 'עסקה', $2, $3, $4) returning id", [
            org,
            pipe.pipelineId,
            open,
            user,
          ])
        ).rows[0].id,
      );
    const lineOf = (user: string, deal: string, productId: string | null) =>
      asUser(user, async (q) =>
        (
          await q<{ id: string }>(
            "insert into public.deal_lines (organization_id, deal_id, product_id, description, quantity, unit_price_agorot, price_source) values ($1, $2, $3, 'שורה', 1, 10000, $4) returning id",
            [org, deal, productId, productId ? "product" : "manual"],
          )
        ).rows[0].id,
      );
    const theirs = await dealOf(member.id);
    const theirLine = await lineOf(member.id, theirs, product);
    const theirFree = await lineOf(member.id, theirs, null);
    const kept = () => asAdmin(async (q) => (await q<{ c: string }>("select cost_agorot::text as c from public.deal_line_costs where deal_line_id = $1", [theirLine])).rows[0]?.c);
    const before = await kept();
    expect(before).toBeDefined();
    const own = await dealOf(costViewer.id);
    const ownLine = await lineOf(costViewer.id, own, product);
    // the grant reads the copy on a deal it reads, but may not change it on a deal it may not edit
    expect(await asUser(costViewer.id, (q) => count(q, "select 1 from public.deal_line_costs where deal_line_id = $1", [theirLine]))).toBe(1);
    expect(await asUser(costViewer.id, async (q) => (await q("update public.deal_line_costs set cost_agorot = 1 where deal_line_id = $1", [theirLine])).rowCount)).toBe(0);
    expect(await asUser(costViewer.id, async (q) => (await q("delete from public.deal_line_costs where deal_line_id = $1", [theirLine])).rowCount)).toBe(0);
    expect(
      (await pgError(asUser(costViewer.id, (q) => q("insert into public.deal_line_costs (organization_id, deal_line_id, cost_agorot) values ($1, $2, 1)", [org, theirFree])))).code,
    ).toBe("42501");
    // on its own open deal it may
    expect(await asUser(costViewer.id, async (q) => (await q("update public.deal_line_costs set cost_agorot = 5000 where deal_line_id = $1", [ownLine])).rowCount)).toBe(1);
    expect(await kept()).toBe(before);

    // reading needs the line's deal too: with own-only visibility the grant does not see another rep's line cost
    const seesTheirs = () => asUser(costViewer.id, (q) => count(q, "select 1 from public.deal_line_costs where deal_line_id = $1", [theirLine]));
    await asAdmin((q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      expect(await seesTheirs()).toBe(0);
      expect(await asUser(costViewer.id, (q) => count(q, "select 1 from public.deal_line_costs where deal_line_id = $1", [ownLine]))).toBe(1);
    } finally {
      await asAdmin((q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
    expect(await seesTheirs()).toBe(1);

    // writing needs a live deal, the products capability and a writable business
    const changes = () => asUser(costViewer.id, async (q) => (await q("update public.deal_line_costs set cost_agorot = cost_agorot + 1 where deal_line_id = $1", [ownLine])).rowCount);
    await asAdmin((q) => q("update public.deals set deleted_at = now() where id = $1", [own]));
    try {
      expect(await changes()).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.deals set deleted_at = null where id = $1", [own]));
    }
    await setFlag("products", false);
    try {
      expect(await changes()).toBe(0);
    } finally {
      await setFlag("products", null);
    }
    const status = await asAdmin(async (q) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org])).rows[0].status);
    await asAdmin((q) => q("update public.organizations set status = 'read_only' where id = $1", [org]));
    try {
      expect(await changes()).toBe(0);
    } finally {
      await asAdmin((q) => q("update public.organizations set status = $1 where id = $2", [status, org]));
    }
    expect(await changes()).toBe(1);

    // the line and the business of a cost are fixed: no client may change them
    const updatable = await asAdmin(async (q) =>
      (
        await q<{ c: string }>(
          "select column_name as c from information_schema.column_privileges where table_schema = 'public' and table_name = 'deal_line_costs' and grantee = 'authenticated' and privilege_type = 'UPDATE' order by 1",
        )
      ).rows.map((r) => r.c),
    );
    expect(updatable).toEqual(["cost_agorot", "currency"]);
  });
});

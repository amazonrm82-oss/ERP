import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asMfaUser, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

// ADM-04: system banners. Written only by the platform owner or support (aal2, logged); a member reads only the banners
// that apply to their business now, through one definer function; each person closes a dismissable banner for themselves.

const staffIds: string[] = [];
const bannerIds: string[] = [];
const makeStaff = (userId: string, role: string) => {
  staffIds.push(userId);
  return asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));
};

afterAll(async () => {
  await asAdmin((q) => q("delete from app.system_banners where id = any($1)", [bannerIds]));
  await asAdmin((q) => q("delete from app.platform_staff where user_id = any($1)", [staffIds]));
  await closePool();
});

type Banner = { id: string; body: string; severity: string; dismissable: boolean };

const add = async (
  userId: string,
  opts: { body?: string; severity?: string; dismissable?: boolean; starts?: string | null; ends?: string; kind?: string; orgs?: string[] | null; plan?: string | null },
) => {
  const id = await asMfaUser(userId, async (q) =>
    (
      await q<{ id: string }>("select public.platform_add_system_banner($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7::uuid[], $8) as id", [
        opts.body ?? "תחזוקה מתוכננת",
        opts.severity ?? "info",
        opts.dismissable ?? true,
        opts.starts ?? null,
        opts.ends ?? new Date(Date.now() + 86_400_000).toISOString(),
        opts.kind ?? "all",
        opts.orgs ?? null,
        opts.plan ?? null,
      ])
    ).rows[0].id,
  );
  bannerIds.push(id);
  return id;
};
const shown = (userId: string, org: string) =>
  asUser(userId, async (q) => (await q<{ b: Banner[] }>("select public.system_banners_for($1) as b", [org])).rows[0].b);
const ids = (list: Banner[]) => list.map((b) => b.id);

describe("ADM-04: system banners", () => {
  let owner: { id: string };
  let support: { id: string };
  let finance: { id: string };
  let alice: { id: string };
  let bob: { id: string };
  let carol: { id: string };
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    owner = await createUser("adm04-owner");
    support = await createUser("adm04-support");
    finance = await createUser("adm04-finance");
    await makeStaff(owner.id, "owner");
    await makeStaff(support.id, "support");
    await makeStaff(finance.id, "finance");
    alice = await createUser("adm04-alice");
    bob = await createUser("adm04-bob");
    orgA = await createOrg(alice.id, "עסק א");
    orgB = await createOrg(bob.id, "עסק ב");
    carol = await addMember(orgA, alice.id, "member", "adm04-carol");
  });

  it("only the platform owner or support with two-step verification add a banner; it is logged", async () => {
    // finance, a plain user and support without aal2 are refused
    expect((await pgError(asMfaUser(finance.id, (q) => q("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'all', null, null)")))).code).toBe("42501");
    expect((await pgError(asMfaUser(alice.id, (q) => q("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'all', null, null)")))).code).toBe("42501");
    expect((await pgError(asUser(support.id, (q) => q("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'all', null, null)")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'all', null, null)")))).code).toBe("42501");

    const id = await add(support.id, { body: "  שדרוג   מערכת\nבלילה  " });
    const row = await asAdmin(async (q) => (await q<{ body: string; created_by: string }>("select body, created_by from app.system_banners where id = $1", [id])).rows[0]);
    expect(row.body).toBe("שדרוג מערכת בלילה");
    expect(row.created_by).toBe(support.id);
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'banner.add' and details->>'id' = $1", [id]))).toBe(1);
  });

  it("refuses bad input", async () => {
    const bad = async (sql: string) => (await pgError(asMfaUser(owner.id, (q) => q(sql)))).code;
    expect(await bad("select public.platform_add_system_banner('', 'info', true, null, now() + interval '1 day', 'all', null, null)")).toBe("22023");
    expect(await bad(`select public.platform_add_system_banner('${"א".repeat(301)}', 'info', true, null, now() + interval '1 day', 'all', null, null)`)).toBe("22023");
    expect(await bad("select public.platform_add_system_banner('x', 'danger', true, null, now() + interval '1 day', 'all', null, null)")).toBe("22023");
    expect(await bad("select public.platform_add_system_banner('x', 'info', true, null, now() - interval '1 day', 'all', null, null)")).toBe("22023");
    expect(await bad("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '400 days', 'all', null, null)")).toBe("22023");
    expect(await bad("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'orgs', '{}'::uuid[], null)")).toBe("22023");
    expect(await bad(`select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'orgs', array['${crypto.randomUUID()}']::uuid[], null)`)).toBe("22023");
    expect(await bad("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'plan', null, 'no-such-plan')")).toBe("22023");
    expect(await bad("select public.platform_add_system_banner('x', 'info', true, null, now() + interval '1 day', 'everyone', null, null)")).toBe("22023");
  });

  it("members see only what applies to their business now; outsiders and anon see nothing", async () => {
    const all = await add(owner.id, { body: "לכולם" });
    const onlyA = await add(owner.id, { body: "לעסק א", kind: "orgs", orgs: [orgA] });
    const planKey = await asAdmin(async (q) => (await q<{ k: string }>("select plan_key as k from public.subscriptions where organization_id = $1", [orgB])).rows[0].k);
    // move B to another plan so the plan banner reaches A only
    const other = await asAdmin(async (q) => (await q<{ k: string }>("select key as k from public.plans where key <> $1 order by key limit 1", [planKey])).rows[0].k);
    const aPlan = await asAdmin(async (q) => (await q<{ k: string }>("select plan_key as k from public.subscriptions where organization_id = $1", [orgA])).rows[0].k);
    await asAdmin((q) => q("update public.subscriptions set plan_key = $2 where organization_id = $1", [orgB, aPlan === other ? planKey : other]));
    const byPlan = await add(owner.id, { body: "לחבילה", kind: "plan", plan: aPlan });
    const future = await add(owner.id, { body: "בעתיד", starts: new Date(Date.now() + 3_600_000).toISOString() });

    const forCarol = ids(await shown(carol.id, orgA));
    expect(forCarol).toEqual(expect.arrayContaining([all, onlyA, byPlan].slice(0, 3)));
    expect(forCarol).not.toContain(future);
    const forBob = ids(await shown(bob.id, orgB));
    expect(forBob).toContain(all);
    expect(forBob).not.toContain(onlyA);
    expect(forBob).not.toContain(byPlan);
    // bob is not a member of A: nothing, whatever applies there
    expect(await shown(bob.id, orgA)).toEqual([]);
    expect(
      await asAnon(async (q) => (await pgError(q("select public.system_banners_for($1)", [orgA]))).code),
    ).toBe("42501");
    // no API role reads the tables
    expect((await pgError(asUser(alice.id, (q) => q("select * from app.system_banners")))).code).toBe("42501");
    expect((await pgError(asUser(alice.id, (q) => q("select * from app.system_banner_dismissals")))).code).toBe("42501");
  });

  it("at most three banners, warnings first", async () => {
    const warn = await add(owner.id, { body: "אזהרה", severity: "warning", kind: "orgs", orgs: [orgA] });
    const list = await shown(alice.id, orgA);
    expect(list.length).toBeLessThanOrEqual(3);
    expect(list[0].id).toBe(warn);
    expect(list[0].severity).toBe("warning");
  });

  it("a person closes a banner for themselves only; a non-dismissable warning stays", async () => {
    const info = await add(owner.id, { body: "רק לא", kind: "orgs", orgs: [orgA], severity: "warning" });
    await asUser(carol.id, (q) => q("select public.system_banner_dismiss($1, $2)", [orgA, info]));
    // twice is fine
    await asUser(carol.id, (q) => q("select public.system_banner_dismiss($1, $2)", [orgA, info]));
    expect(ids(await shown(carol.id, orgA))).not.toContain(info);
    expect(ids(await shown(alice.id, orgA))).toContain(info);

    const sticky = await add(owner.id, { body: "חשוב", severity: "warning", dismissable: false, kind: "orgs", orgs: [orgA] });
    const err = await pgError(asUser(carol.id, (q) => q("select public.system_banner_dismiss($1, $2)", [orgA, sticky])));
    expect(err.hint).toBe("banner:not_dismissable");
    // an info banner is always dismissable, whatever was asked
    const infoSticky = await add(owner.id, { body: "מידע", severity: "info", dismissable: false, kind: "orgs", orgs: [orgA] });
    expect(await asAdmin(async (q) => (await q<{ d: boolean }>("select dismissable as d from app.system_banners where id = $1", [infoSticky])).rows[0].d)).toBe(true);

    // bob cannot dismiss through another business, nor a banner that does not apply to his
    expect((await pgError(asUser(bob.id, (q) => q("select public.system_banner_dismiss($1, $2)", [orgA, info])))).code).toBe("42501");
    expect((await pgError(asUser(bob.id, (q) => q("select public.system_banner_dismiss($1, $2)", [orgB, info])))).code).toBe("P0002");
  });

  it("support ends a banner early; it disappears and the end is logged", async () => {
    const id = await add(owner.id, { body: "לסיום", kind: "orgs", orgs: [orgB] });
    expect(ids(await shown(bob.id, orgB))).toContain(id);
    expect((await pgError(asMfaUser(finance.id, (q) => q("select public.platform_end_system_banner($1)", [id])))).code).toBe("42501");
    await asMfaUser(support.id, (q) => q("select public.platform_end_system_banner($1)", [id]));
    await asMfaUser(support.id, (q) => q("select public.platform_end_system_banner($1)", [id]));
    expect(ids(await shown(bob.id, orgB))).not.toContain(id);
    expect(await asAdmin((q) => count(q, "select 1 from app.platform_log where action = 'banner.end' and details->>'id' = $1", [id]))).toBe(1);
  });

  it("every platform role lists banners; members cannot", async () => {
    const list = await asMfaUser(finance.id, async (q) => (await q<{ l: { id: string; target_orgs: { name: string }[] }[] }>("select public.platform_list_system_banners() as l")).rows[0].l);
    expect(list.length).toBeGreaterThan(0);
    const onlyA = list.find((b) => b.target_orgs.length === 1);
    expect(onlyA?.target_orgs[0].name).toBeTruthy();
    expect((await pgError(asMfaUser(alice.id, (q) => q("select public.platform_list_system_banners()")))).code).toBe("42501");
  });
});

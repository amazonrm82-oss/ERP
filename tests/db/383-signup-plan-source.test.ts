import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asMfaUser, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

// WEB-02: the plan chosen on the price list and the sign-up source ride in the person's own Auth metadata to their FIRST
// business. public.create_organization honours the plan only while it is available, folds the source again (LND-14), and
// keeps both in app.org_signup_origins (no client grants). The platform panel reads them.

type U = { id: string; email: string };

const userWithMeta = async (label: string, meta: Record<string, unknown>): Promise<U> => {
  const user = await createUser(label);
  await asAdmin((q) => q("update auth.users set raw_user_meta_data = raw_user_meta_data || $2::jsonb where id = $1", [user.id, JSON.stringify(meta)]));
  return user;
};

const subscription = (org: string) =>
  asAdmin(async (q) => (await q<{ plan_key: string; status: string; days: number }>(
    "select plan_key, status::text as status, round(extract(epoch from trial_ends_at - now()) / 86400)::int as days from public.subscriptions where organization_id = $1",
    [org],
  )).rows[0]);

const origin = (org: string) =>
  asAdmin(async (q) => (await q<{ source: string | null; plan_key: string | null }>(
    "select source, plan_key from app.org_signup_origins where organization_id = $1",
    [org],
  )).rows[0]);

describe("sign-up plan and source (WEB-02)", () => {
  let available: string;
  let comingSoon: string | null;
  let hidden: string | null;

  beforeAll(async () => {
    const plans = await asAdmin(async (q) => (await q<{ key: string; availability: string }>("select key, availability from public.plans order by position")).rows);
    available = plans.find((p) => p.availability === "available" && p.key !== "pro")!.key;
    comingSoon = plans.find((p) => p.availability === "coming_soon")?.key ?? null;
    hidden = plans.find((p) => p.availability === "hidden")?.key ?? null;
    expect(available).toBeTruthy();
  });

  it("no choice: exactly today's 14-day pro trial, and nothing recorded", async () => {
    const user = await createUser("web02-plain");
    const org = await createOrg(user.id);
    expect(await subscription(org)).toEqual({ plan_key: "pro", status: "trialing", days: 14 });
    expect(await origin(org)).toBeUndefined();
  });

  it("an available plan becomes the trial plan, and the source and plan are kept", async () => {
    const user = await userWithMeta("web02-plan", { signup_plan: available, signup_source: "facebook" });
    const org = await createOrg(user.id);
    expect(await subscription(org)).toEqual({ plan_key: available, status: "trialing", days: 14 });
    expect(await origin(org)).toEqual({ source: "facebook", plan_key: available });
  });

  it("a coming-soon, hidden or unknown plan is ignored silently (pro trial), the source still kept", async () => {
    // the proof needs a real hidden and a real coming-soon plan in the build
    expect(hidden).not.toBeNull();
    expect(comingSoon).not.toBeNull();
    for (const plan of [comingSoon, hidden, "no_such_plan", "PRO", 7].filter((p) => p !== null)) {
      const user = await userWithMeta("web02-bad", { signup_plan: plan, signup_source: "google" });
      const org = await createOrg(user.id);
      expect((await subscription(org)).plan_key).toBe("pro");
      expect(await origin(org)).toEqual({ source: "google", plan_key: null });
    }
  });

  it("the source is folded again by LND-14's rule; a non-string is ignored", async () => {
    const cases: Array<[unknown, string | null]> = [
      ["  News-Letter ", "news-letter"],
      ["", "direct"],
      ["שלום", "other"],
      ["x".repeat(41), "other"],
      [42, null],
    ];
    for (const [raw, folded] of cases) {
      const user = await userWithMeta("web02-src", { signup_source: raw, signup_plan: available });
      const org = await createOrg(user.id);
      expect((await origin(org))?.source ?? null).toBe(folded);
    }
  });

  it("applies to the person's first own business only", async () => {
    const user = await userWithMeta("web02-second", { signup_plan: available, signup_source: "direct" });
    const first = await createOrg(user.id, "ראשון");
    const second = await createOrg(user.id, "שני");
    expect((await subscription(first)).plan_key).toBe(available);
    expect(await subscription(second)).toEqual({ plan_key: "pro", status: "trialing", days: 14 });
    expect(await origin(second)).toBeUndefined();
  });

  it("no client reads or writes the kept origin", async () => {
    const user = await userWithMeta("web02-grants", { signup_source: "direct" });
    const org = await createOrg(user.id);
    for (const sql of [
      "select * from app.org_signup_origins",
      "update app.org_signup_origins set source = 'x' where organization_id = $1",
      "insert into app.org_signup_origins (organization_id, source) values ($1, 'x')",
    ]) {
      const params = sql.includes("$1") ? [org] : [];
      expect((await pgError(asUser(user.id, (q) => q(sql, params)))).code).toBe("42501");
    }
    // the table's own guards
    const grants = await asAdmin(async (q) => (await q<{ n: number }>(
      "select count(*)::int as n from information_schema.role_table_grants where table_schema = 'app' and table_name = 'org_signup_origins' and grantee in ('anon', 'authenticated', 'public')",
    )).rows[0].n);
    expect(grants).toBe(0);
    expect((await pgError(asAdmin((q) => q("insert into app.org_signup_origins (organization_id, source) values ($1, 'Bad Source')", [org]))))).toMatchObject({ code: "23514" });
  });

  it("the platform panel shows the source and the chosen plan; a member cannot read it", async () => {
    const user = await userWithMeta("web02-panel", { signup_plan: available, signup_source: "newsletter" });
    const org = await createOrg(user.id, "עסק מהמחירון");
    const plain = await createOrg((await createUser("web02-panel-plain")).id, "עסק רגיל");

    const staff = await createUser("web02-staff");
    await asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, 'readonly')", [staff.id]));
    const call = <T>(sql: string, params: unknown[] = []) => asMfaUser(staff.id, async (q) => (await q<{ r: T }>(sql, params)).rows[0].r);

    const card = await call<{ signup: { source: string; plan_key: string } | null }>("select public.platform_org($1) as r", [org]);
    expect(card.signup).toMatchObject({ source: "newsletter", plan_key: available });
    expect((await call<{ signup: unknown }>("select public.platform_org($1) as r", [plain])).signup).toBeNull();

    const list = await call<{ rows: Array<{ id: string; signup_source: string | null; signup_plan: string | null }> }>(
      "select public.platform_list_orgs(null, null, null, 200, 0) as r",
    );
    expect(list.rows.find((r) => r.id === org)).toMatchObject({ signup_source: "newsletter", signup_plan: available });
    expect(list.rows.find((r) => r.id === plain)).toMatchObject({ signup_source: null, signup_plan: null });

    expect((await pgError(asMfaUser(user.id, (q) => q("select public.platform_org($1)", [org])))).code).toBe("42501");
  });
});

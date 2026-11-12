import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asService, asUser, closePool, createUser, pgError, type Query } from "./helpers";

afterAll(closePool);

// LND-13 / WEB-01 (owner, 11 November 2026): the landing page's price list calls public.plans_public() with the anon key. It is
// the second function anon may execute (test 01), so this test pins what it is (sql, stable, definer, no argument,
// search_path '', the body by md5), whom it is granted to, what it reads (only public.plans) and what it answers (the public
// fields of available and coming-soon plans only). A change here needs a fresh review.

// md5(prosrc) of the reviewed body (migration 20261006021232_plans_public.sql)
const REVIEWED_BODY_MD5 = "6c246066dbf154393d0f4a05288c67f4";

type PublicPlan = Record<string, unknown> & { key: string; availability: string; limits: Record<string, unknown>; features: string[] };

const PLAN_FIELDS = ["availability", "features", "key", "limits", "name", "position", "price_annual_agorot", "price_monthly_agorot", "price_unit"];
const LIMIT_FIELDS = new Set(["max_records", "max_users", "storage_gb"]);

class Rollback extends Error {
  constructor(readonly value: unknown) {
    super("rollback");
  }
}

/** Arranges plan rows as the superuser, calls the function as anon, and rolls everything back. */
async function anonAfter(arrange: (q: Query) => Promise<void>): Promise<PublicPlan[]> {
  try {
    await asAdmin(async (q) => {
      await arrange(q);
      await q("select set_config('request.jwt.claims', '', true)");
      await q("set local role anon");
      const value = (await q<{ plans: PublicPlan[] }>("select public.plans_public() as plans")).rows[0].plans;
      throw new Rollback(value);
    });
  } catch (error) {
    if (error instanceof Rollback) return error.value as PublicPlan[];
    throw error;
  }
  throw new Error("unreachable");
}

describe("public price list (LND-13)", () => {
  it("anon and authenticated get it; the service role and PUBLIC do not", async () => {
    const anon = (await asAnon((q) => q<{ plans: PublicPlan[] }>("select public.plans_public() as plans"))).rows[0].plans;
    expect(Array.isArray(anon)).toBe(true);
    expect(anon.length).toBeGreaterThan(0);
    const user = await createUser("plans-public");
    const signedIn = (await asUser(user.id, (q) => q<{ plans: PublicPlan[] }>("select public.plans_public() as plans"))).rows[0].plans;
    expect(signedIn).toEqual(anon);
    expect((await pgError(asService((q) => q("select public.plans_public()")))).code).toBe("42501");

    const rows = await asAdmin(async (q) =>
      (
        await q<{ role: string; can: boolean }>(`
          select r.rolname as role, has_function_privilege(r.oid, 'public.plans_public()'::regprocedure, 'execute') as can
          from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role') order by 1`)
      ).rows,
    );
    expect(rows).toEqual([
      { role: "anon", can: true },
      { role: "authenticated", can: true },
      { role: "service_role", can: false },
    ]);
    const acl = await asAdmin(async (q) =>
      (
        await q<{ grantee: string }>(`
          select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee
          from pg_proc p, aclexplode(p.proacl) a
          where p.oid = 'public.plans_public()'::regprocedure and a.privilege_type = 'EXECUTE'
          order by 1`)
      ).rows.map((r) => r.grantee),
    );
    // the owner keeps its own grant; PUBLIC and the service role have none
    expect(acl.filter((g) => g !== "postgres")).toEqual(["anon", "authenticated"]);
  });

  it("is sql, stable, definer, no arguments, search_path '', returns jsonb, with the reviewed body", async () => {
    const [fn] = await asAdmin(async (q) =>
      (
        await q<{ md5: string; lang: string; volatile: string; definer: boolean; nargs: number; rettype: string; config: string[] | null }>(`
          select md5(p.prosrc) as md5, l.lanname as lang, p.provolatile as volatile, p.prosecdef as definer,
                 p.pronargs as nargs, p.prorettype::regtype::text as rettype, p.proconfig as config
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
          where n.nspname = 'public' and p.proname = 'plans_public'`)
      ).rows,
    );
    expect(fn).toEqual({ md5: REVIEWED_BODY_MD5, lang: "sql", volatile: "s", definer: true, nargs: 0, rettype: "jsonb", config: ['search_path=""'] });
  });

  it("reads public.plans and nothing else", async () => {
    const deps = await asAdmin(async (q) =>
      (
        await q<{ dep: string }>(`
          select distinct case when d.refclassid = 'pg_class'::regclass then d.refobjid::regclass::text
                               else d.refobjid::regprocedure::text end as dep
          from pg_depend d
          where d.objid = 'public.plans_public()'::regprocedure and d.deptype = 'n'
            and d.refclassid in ('pg_class'::regclass, 'pg_proc'::regclass)
          order by 1`)
      ).rows.map((r) => r.dep),
    );
    // sql bodies are not tracked in pg_depend: check the text names no other relation or schema-qualified function
    expect(deps.filter((d) => d !== "plans")).toEqual([]);
    const body = await asAdmin(async (q) => (await q<{ src: string }>("select prosrc as src from pg_proc where oid = 'public.plans_public()'::regprocedure")).rows[0].src);
    expect([...body.matchAll(/\b(public|app|auth|storage)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`)).toEqual(["public.plans"]);
  });

  it("answers the available and coming-soon plans only, in position order, with only the public fields", async () => {
    const plans = await anonAfter(async () => undefined);
    const all = await asAdmin(async (q) =>
      (await q<{ key: string; availability: string }>("select key, availability from public.plans order by position, key")).rows,
    );
    expect(plans.map((p) => p.key)).toEqual(all.filter((p) => p.availability !== "hidden").map((p) => p.key));
    expect(plans.some((p) => p.key === "free")).toBe(false);
    expect(plans.find((p) => p.key === "business")?.availability).toBe("coming_soon");
    for (const plan of plans) {
      expect(Object.keys(plan).sort()).toEqual(PLAN_FIELDS);
      expect(Object.keys(plan.limits).every((k) => LIMIT_FIELDS.has(k)), plan.key).toBe(true);
      expect(plan.features.every((f) => typeof f === "string")).toBe(true);
    }
    const personal = plans.find((p) => p.key === "personal");
    expect(personal).toMatchObject({ name: "אישית", price_monthly_agorot: 7900, price_annual_agorot: 6900, price_unit: "org", availability: "available" });
    expect(personal?.limits).toEqual({ max_users: 2, max_records: 10000, storage_gb: 2 });
  });

  it("names only listed flags that are on, in the list's order, and only the three quota lines, whatever else the plan holds", async () => {
    const plans = await anonAfter(async (q) => {
      // sms after quotes in the closed list; api and sso are not built, consents and internal_flag are not capabilities
      await q(
        `update public.plans
            set features = '{"sms": true, "quotes": true, "orders": false, "internal_flag": true, "consents": true, "api": true, "sso": null, "products": "true"}'::jsonb,
                limits = '{"max_users": 3, "max_records": null, "storage_gb": "lots", "ai_credits_per_month": 9, "max_pdf_per_month": 1}'::jsonb
          where key = 'personal'`,
      );
      await q("update public.plans set availability = 'hidden' where key = 'basic'");
      await q("update public.plans set availability = 'coming_soon' where key = 'free'");
      await q("update public.plans set features = '[]'::jsonb, limits = 'null'::jsonb where key = 'pro'");
    });
    const personal = plans.find((p) => p.key === "personal");
    expect(personal?.features).toEqual(["quotes", "sms"]);
    // a text value is not a quota; null (no cap) is kept
    expect(personal?.limits).toEqual({ max_users: 3, max_records: null });
    expect(plans.some((p) => p.key === "basic")).toBe(false);
    expect(plans.find((p) => p.key === "free")?.availability).toBe("coming_soon");
    expect(plans.find((p) => p.key === "pro")).toMatchObject({ features: [], limits: {} });
  });

  it("answers an empty list when no plan is shown", async () => {
    expect(await anonAfter(async (q) => void (await q("update public.plans set availability = 'hidden'")))).toEqual([]);
  });

  it("anon still cannot read the plans table itself", async () => {
    expect((await pgError(asAnon((q) => q("select * from public.plans")))).code).toBe("42501");
  });
});

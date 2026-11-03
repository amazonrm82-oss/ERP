import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, asAnon, asService, asUser, closePool, createUser } from "./helpers";

afterAll(closePool);

// OPS-05 (owner (72) ב, 3 November 2026): the uptime route calls public.health_check() with the anon key. It is the one
// function anon may execute (test 01), so it must answer the constant true and touch nothing: no table, no argument, no
// setting, invoker, search_path ''. A change here needs a fresh review.
describe("health check (OPS-05)", () => {
  it("anon, authenticated and the service role get true", async () => {
    expect((await asAnon((q) => q<{ ok: boolean }>("select public.health_check() as ok"))).rows[0].ok).toBe(true);
    const user = await createUser("health");
    expect((await asUser(user.id, (q) => q<{ ok: boolean }>("select public.health_check() as ok"))).rows[0].ok).toBe(true);
    expect((await asService((q) => q<{ ok: boolean }>("select public.health_check() as ok"))).rows[0].ok).toBe(true);
  });

  it("is a constant: sql, stable, invoker, no arguments, search_path '', body `select true`", async () => {
    const row = await asAdmin(async (q) =>
      (
        await q<{
          body: string;
          lang: string;
          volatile: string;
          definer: boolean;
          nargs: number;
          rettype: string;
          config: string[] | null;
        }>(`
          select p.prosrc as body, l.lanname as lang, p.provolatile as volatile, p.prosecdef as definer,
                 p.pronargs as nargs, p.prorettype::regtype::text as rettype, p.proconfig as config
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          join pg_language l on l.oid = p.prolang
          where n.nspname = 'public' and p.proname = 'health_check'`)
      ).rows,
    );
    expect(row).toHaveLength(1);
    const [fn] = row;
    expect(fn.body.trim()).toBe("select true");
    expect(fn.lang).toBe("sql");
    expect(fn.volatile).toBe("s");
    expect(fn.definer).toBe(false);
    expect(fn.nargs).toBe(0);
    expect(fn.rettype).toBe("boolean");
    expect(fn.config).toEqual(['search_path=""']);
  });

  it("depends on no table, view or other function", async () => {
    const deps = await asAdmin(async (q) =>
      (
        await q<{ dep: string }>(`
          select d.classid::regclass::text || ':' || d.objid::text as dep
          from pg_depend d
          where d.objid = 'public.health_check()'::regprocedure
            and d.deptype = 'n'
            and d.refclassid in ('pg_class'::regclass, 'pg_proc'::regclass)`)
      ).rows,
    );
    expect(deps).toEqual([]);
  });

  it("execute is granted to anon, authenticated and the service role only (not to public)", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ role: string; can: boolean }>(`
          select r.rolname as role, has_function_privilege(r.oid, 'public.health_check()'::regprocedure, 'execute') as can
          from pg_roles r
          where r.rolname in ('anon', 'authenticated', 'service_role')
          order by 1`)
      ).rows,
    );
    expect(rows).toEqual([
      { role: "anon", can: true },
      { role: "authenticated", can: true },
      { role: "service_role", can: true },
    ]);
    const acl = await asAdmin(async (q) =>
      (
        await q<{ grantee: string }>(`
          select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee
          from pg_proc p, aclexplode(p.proacl) a
          where p.oid = 'public.health_check()'::regprocedure and a.grantee = 0`)
      ).rows,
    );
    expect(acl).toEqual([]);
  });
});

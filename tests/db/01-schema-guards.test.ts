import { afterAll, describe, expect, it } from "vitest";
import { asAdmin, asAnon, closePool, pgError } from "./helpers";

afterAll(closePool);

/**
 * Structural rules. These fail the moment a future migration adds a table or
 * a function and forgets to lock it down.
 */
describe("schema guards", () => {
  it("every table in public has row level security enabled", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ relname: string }>(`
          select c.relname
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
          order by 1`)
      ).rows.map((r) => r.relname),
    );
    expect(rows).toEqual([]);
  });

  // RVW-15: the live project has RLS on every table of schema app; the repo must match, and a
  // future app table must not forget it. Not FORCEd: the security definer functions that use
  // these tables run as the table owner and must keep bypassing RLS.
  it("every table in schema app has row level security enabled, not forced, and owned by the function owner", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string }>(`
          select c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) as owner
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'app' and c.relkind in ('r', 'p')
          order by 1`)
      ).rows,
    );
    expect(rows.length).toBeGreaterThanOrEqual(9);
    expect(rows.filter((r) => !r.relrowsecurity).map((r) => r.relname)).toEqual([]);
    expect(rows.filter((r) => r.relforcerowsecurity).map((r) => r.relname)).toEqual([]);
    const definerOwners = await asAdmin(async (q) =>
      (
        await q<{ owner: string }>(`
          select distinct pg_get_userbyid(p.proowner) as owner
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('app', 'public') and p.prosecdef`)
      ).rows.map((r) => r.owner),
    );
    expect(definerOwners.length).toBeGreaterThan(0);
    for (const r of rows) expect(definerOwners).toContain(r.owner);
    // an invoker function or trigger reading an app table would silently see 0 rows under RLS
    const pattern = `app\\.(${rows.map((r) => r.relname).join("|")})\\M`;
    const invokers = await asAdmin(async (q) =>
      (
        await q<{ fn: string }>(
          `select n.nspname || '.' || p.proname as fn
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('app', 'public') and not p.prosecdef and p.prosrc ~ $1
           order by 1`,
          [pattern],
        )
      ).rows.map((r) => r.fn),
    );
    expect(invokers).toEqual([]);
  });

  it("every tenant table except the outbox has a select policy", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ table_name: string }>(`
          select c.table_name
          from information_schema.columns c
          where c.table_schema = 'public' and c.column_name = 'organization_id'
            and c.table_name <> 'outbox_events'
            and not exists (
              select 1 from pg_policies p
              where p.schemaname = 'public' and p.tablename = c.table_name and p.cmd in ('SELECT', 'ALL'))
          order by 1`)
      ).rows.map((r) => r.table_name),
    );
    expect(rows).toEqual([]);
  });

  it("anon has no privilege on any table or column", async () => {
    const result = await asAdmin(async (q) => {
      const tables = await q(`
        select table_name, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and grantee = 'anon'`);
      const columns = await q(`
        select table_name, column_name from information_schema.column_privileges
        where table_schema = 'public' and grantee = 'anon'`);
      return { tables: tables.rows, columns: columns.rows };
    });
    expect(result.tables).toEqual([]);
    expect(result.columns).toEqual([]);
  });

  it("anon cannot execute any function in public or app", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ fn: string }>(`
          select n.nspname || '.' || p.proname as fn
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'app') and has_function_privilege('anon', p.oid, 'execute')
          order by 1`)
      ).rows.map((r) => r.fn),
    );
    expect(rows).toEqual([]);
  });

  it("anon is refused at run time too", async () => {
    expect((await pgError(asAnon((q) => q("select * from public.leads")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select * from public.plans")))).code).toBe("42501");
    expect((await pgError(asAnon((q) => q("select public.create_organization('x')")))).code).toBe("42501");
  });

  it("every SECURITY DEFINER function pins its search_path", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ fn: string }>(`
          select n.nspname || '.' || p.proname as fn
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'app') and p.prosecdef
            and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
          order by 1`)
      ).rows.map((r) => r.fn),
    );
    expect(rows).toEqual([]);
  });

  it("authenticated cannot write the tables that belong to the server", async () => {
    const checks: [string, string][] = [
      ["public.outbox_events", "select"],
      ["public.outbox_events", "insert"],
      ["public.audit_log", "insert"],
      ["public.audit_log", "update"],
      ["public.audit_log", "delete"],
      ["public.subscriptions", "insert"],
      ["public.subscriptions", "update"],
      ["public.subscriptions", "delete"],
      ["public.org_usage", "update"],
      ["public.organizations", "insert"],
      ["public.organizations", "delete"],
      ["public.memberships", "insert"],
      ["public.invitations", "insert"],
      ["public.plans", "insert"],
      ["public.plans", "update"],
      ["public.profiles", "insert"],
      ["public.notifications", "insert"],
    ];
    const allowed = await asAdmin(async (q) => {
      const out: string[] = [];
      for (const [table, privilege] of checks) {
        const res = await q<{ ok: boolean }>("select has_table_privilege('authenticated', $1, $2) as ok", [
          table,
          privilege,
        ]);
        if (res.rows[0].ok) out.push(`${privilege} on ${table}`);
      }
      return out;
    });
    expect(allowed).toEqual([]);
  });

  it("authenticated cannot update the protected columns", async () => {
    const checks: [string, string][] = [
      ["public.organizations", "status"],
      ["public.organizations", "slug"],
      ["public.organizations", "deleted_at"],
      ["public.memberships", "organization_id"],
      ["public.memberships", "user_id"],
      ["public.profiles", "email"],
      ["public.invitations", "role"],
      ["public.invitations", "accepted_at"],
      ["public.invitations", "token_hash"],
      ["public.notifications", "user_id"],
      ["public.activities", "organization_id"],
      ["public.activities", "created_by"],
    ];
    const allowed = await asAdmin(async (q) => {
      const out: string[] = [];
      for (const [table, column] of checks) {
        const res = await q<{ ok: boolean }>(
          "select has_column_privilege('authenticated', $1, $2, 'update') as ok",
          [table, column],
        );
        if (res.rows[0].ok) out.push(`${table}.${column}`);
      }
      return out;
    });
    expect(allowed).toEqual([]);
  });
});

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { assertSafeTestUrl, TEST_DB_URL } from "./helpers";

/**
 * Runs once before the database tests: re-creates the throwaway test database
 * and applies the Supabase stand-in plus every migration, in order.
 */
// Every function of the API and app schemas with the md5 of its definition (aggregates have none).
const FUNCTION_BODIES = `
  select p.oid::regprocedure::text as name, md5(pg_get_functiondef(p.oid)) as body
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'public') and p.prokind in ('f', 'p')`;

async function functionBodies(db: Client): Promise<Map<string, string>> {
  const { rows } = await db.query<{ name: string; body: string }>(FUNCTION_BODIES);
  return new Map(rows.map((row) => [row.name, row.body]));
}

// Every other object a re-run migration can put back to an older state, in the schemas app, public and storage (the shim's
// storage.objects policies), one row per object: its key and a canonical text of its definition. Grants are exploded and
// sorted, so a `revoke all … grant …` that gives the same rights in another order counts as equal.
//   policy: command, permissive, roles, USING and WITH CHECK;  rls: enabled / forced;  grant: table-level privileges;
//   column grant: privileges per column;  function grant: EXECUTE per role;  trigger: its full definition and whether it
//   is enabled;  constraint: its definition.
export const SCHEMA_OBJECTS = `
  with rels as (
    select c.oid, c.relname, c.relkind, c.relowner, c.relacl, c.relrowsecurity, c.relforcerowsecurity, n.nspname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('app', 'public', 'storage') and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S'))
  select 'policy ' || r.nspname || '.' || r.relname || ' ' || p.polname as key,
         concat_ws(' | ', p.polcmd::text, case when p.polpermissive then 'permissive' else 'restrictive' end,
           (select string_agg(case when x = 0 then 'public' else pg_get_userbyid(x) end, ',' order by 1)
              from unnest(p.polroles) as x),
           'using: ' || coalesce(pg_get_expr(p.polqual, p.polrelid), '-'),
           'check: ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '-')) as def
    from pg_policy p join rels r on r.oid = p.polrelid
  union all
  select 'rls ' || r.nspname || '.' || r.relname, r.relrowsecurity::text || ' forced ' || r.relforcerowsecurity::text
    from rels r where r.relkind in ('r', 'p')
  union all
  select 'grant ' || r.nspname || '.' || r.relname,
         coalesce((select string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end,
                                     ',' order by pg_get_userbyid(a.grantee), a.privilege_type)
                     from aclexplode(coalesce(r.relacl, acldefault(case when r.relkind = 'S' then 's' else 'r' end::"char", r.relowner))) a), '')
    from rels r
  union all
  select 'column grant ' || r.nspname || '.' || r.relname || '.' || att.attname,
         (select string_agg(pg_get_userbyid(a.grantee) || ':' || a.privilege_type || case when a.is_grantable then '*' else '' end,
                            ',' order by pg_get_userbyid(a.grantee), a.privilege_type)
            from aclexplode(att.attacl) a)
    from rels r join pg_attribute att on att.attrelid = r.oid
   where att.attnum > 0 and not att.attisdropped and att.attacl is not null
  union all
  select 'function grant ' || p.oid::regprocedure::text,
         coalesce((select string_agg(case when a.grantee = 0 then 'public' else pg_get_userbyid(a.grantee) end || ':' || a.privilege_type,
                                     ',' order by 1)
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a), '')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('app', 'public') and p.prokind in ('f', 'p')
  union all
  select 'trigger ' || r.nspname || '.' || r.relname || ' ' || t.tgname, pg_get_triggerdef(t.oid) || ' enabled ' || t.tgenabled::text
    from pg_trigger t join rels r on r.oid = t.tgrelid
   where not t.tgisinternal
  union all
  select 'constraint ' || r.nspname || '.' || r.relname || ' ' || c.conname, pg_get_constraintdef(c.oid)
    from pg_constraint c join rels r on r.oid = c.conrelid`;

export async function schemaObjects(db: Client): Promise<Map<string, string>> {
  const { rows } = await db.query<{ key: string; def: string | null }>(SCHEMA_OBJECTS);
  return new Map(rows.map((row) => [row.key, row.def ?? ""]));
}

/** What differs between two snapshots, one line per object: changed, missing (a test dropped it) or added by a test. */
export function snapshotDiff(fresh: Map<string, string>, now: Map<string, string>, what: string, show = false): string[] {
  const shown = (def: string | undefined) => (def ?? "").replace(/\s+/g, " ").slice(0, 400);
  return [
    ...[...fresh]
      .filter(([key, def]) => now.has(key) && now.get(key) !== def)
      .map(([key, def]) => `old or changed ${what}: ${key}` + (show ? `\n    fresh: ${shown(def)}\n    now:   ${shown(now.get(key))}` : "")),
    ...[...fresh.keys()].filter((key) => !now.has(key)).map((key) => `missing ${what}: ${key}`),
    ...[...now.keys()].filter((key) => !fresh.has(key)).map((key) => `${what} added by a test: ${key}`),
  ];
}

/**
 * The server at TEST_DATABASE_URL must be the cluster `npm run db:test:start` made in TEST_DB_DIR (its `data`
 * folder, scripts/test-db.sh), so a test run never drops and rebuilds another agent's database on a port it shares.
 * Skipped only in CI without TEST_DB_DIR, where the database is the job's own service container.
 */
export async function assertOwnCluster(db: Client, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (!env.TEST_DB_DIR && env.CI) return;
  const dir = env.TEST_DB_DIR || "/tmp/crm-saas-pgtest";
  const want = path.join(path.resolve(dir), "data");
  const { rows } = await db.query<{ data_directory: string }>("show data_directory");
  const actual = rows[0]?.data_directory ?? "";
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  if (real(actual) !== real(want)) {
    throw new Error(
      `Refusing to rebuild the test database: the server at ${new URL(TEST_DB_URL).host} runs the cluster in "${actual}", ` +
        `not "${want}" (TEST_DB_DIR). Another test database may be using this port; set TEST_DB_PORT, TEST_DB_DIR and ` +
        `TEST_DATABASE_URL to your own and run "npm run db:test:start".`,
    );
  }
}

export default async function setup(): Promise<() => Promise<void>> {
  assertSafeTestUrl(TEST_DB_URL);

  const target = new URL(TEST_DB_URL);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  if (!/^[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Unexpected test database name: ${dbName}`);
  }

  const maintenance = new URL(TEST_DB_URL);
  maintenance.pathname = "/postgres";
  const admin = new Client({ connectionString: maintenance.toString() });
  try {
    await admin.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the local test database at ${target.host}. Start it with "npm run db:test:start". (${String(error)})`,
    );
  }
  try {
    await assertOwnCluster(admin);
  } catch (error) {
    await admin.end();
    throw error;
  }
  await admin.query(`drop database if exists ${dbName} with (force)`);
  await admin.query(`create database ${dbName}`);
  await admin.end();

  const root = path.resolve(__dirname, "../..");
  const migrationsDir = path.join(root, "supabase/migrations");
  const files = [
    path.join(__dirname, "supabase-shim.sql"),
    ...readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => path.join(migrationsDir, f)),
  ];

  let fresh = new Map<string, string>();
  let freshObjects = new Map<string, string>();
  const db = new Client({ connectionString: TEST_DB_URL });
  await db.connect();
  try {
    for (const file of files) {
      try {
        await db.query(readFileSync(file, "utf8"));
      } catch (error) {
        throw new Error(`Failed to apply ${path.basename(file)}: ${String(error)}`);
      }
    }
    // The consent hash key, filled in by the owner on every real environment before the first
    // customer (CNS, owner's decision of 13 October 2026). Tests that need it missing remove it.
    await db.query("insert into app.settings (key, value) values ('consent_hash_key', 'test-consent-key') on conflict (key) do update set value = excluded.value");
    fresh = await functionBodies(db);
    freshObjects = await schemaObjects(db);
  } finally {
    await db.end();
  }

  // After the whole suite, every function must have the body the fresh build gave it, and every policy, RLS switch, grant
  // (table, column, function), trigger and constraint its fresh definition: a test that re-runs an older migration must
  // re-run the later ones that redefine the same functions or reset the same grants and policies (tests/db/rerun.ts), or
  // every test after it runs against an old state. An object a test added or dropped counts too.
  return async () => {
    const after = new Client({ connectionString: TEST_DB_URL });
    await after.connect();
    let now: Map<string, string>;
    let nowObjects: Map<string, string>;
    try {
      now = await functionBodies(after);
      nowObjects = await schemaObjects(after);
    } finally {
      await after.end();
    }
    const problems = [
      ...snapshotDiff(fresh, now, "function body"),
      ...snapshotDiff(freshObjects, nowObjects, "definition", true),
    ];
    if (problems.length > 0) {
      throw new Error(
        `The database tests left functions, policies, grants, triggers or constraints that differ from a fresh build ` +
          `(a test that re-runs a migration must also re-run the later ones: rerunClosure / staleRestores / stalePolicies / ` +
          `staleGrants in tests/db/rerun.ts):\n${problems.join("\n")}`,
      );
    }
  };
}

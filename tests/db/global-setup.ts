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
  } finally {
    await db.end();
  }

  // After the whole suite, every function must have the body the fresh build gave it: a test that re-runs an
  // older migration must re-run the later ones that redefine the same functions (tests/db/rerun.ts), or every
  // test after it runs against an old body. A function a test added or dropped counts too.
  // It compares function bodies only: grants, policies, triggers and constraints a re-run resets are not caught
  // (test 71's `also` re-runs the migration that grants the deal_lines columns again).
  return async () => {
    const after = new Client({ connectionString: TEST_DB_URL });
    await after.connect();
    let now: Map<string, string>;
    try {
      now = await functionBodies(after);
    } finally {
      await after.end();
    }
    const problems = [
      ...[...fresh].filter(([name, body]) => now.has(name) && now.get(name) !== body).map(([name]) => `old or changed body: ${name}`),
      ...[...fresh.keys()].filter((name) => !now.has(name)).map((name) => `missing: ${name}`),
      ...[...now.keys()].filter((name) => !fresh.has(name)).map((name) => `added by a test: ${name}`),
    ];
    if (problems.length > 0) {
      throw new Error(`The database tests left function bodies that differ from a fresh build:\n${problems.join("\n")}`);
    }
  };
}

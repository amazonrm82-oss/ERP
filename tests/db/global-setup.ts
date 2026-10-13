import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { assertSafeTestUrl, TEST_DB_URL } from "./helpers";

/**
 * Runs once before the database tests: re-creates the throwaway test database
 * and applies the Supabase stand-in plus every migration, in order.
 */
export default async function setup(): Promise<void> {
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
  } finally {
    await db.end();
  }
}

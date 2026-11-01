import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The migrations, read once per test file (vitest gives every test file its own module graph) and kept in memory.
// Several unit tests check that an app list equals the LATEST migration that sets it. They used to read all ~400 files
// (7 MB) once per lookup, which under load came close to vitest's 5 s timeout. Here the directory is listed once, each
// file is read at most once, and a "latest that matches" lookup walks the files newest first and stops at the first
// match: the same answer as reading everything in name order and taking the last match.

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../../supabase/migrations/", import.meta.url));

let names: readonly string[] | undefined;
const texts = new Map<string, string>();

/** Every migration file name, in apply order (name order). */
export function migrationNames(): readonly string[] {
  names ??= Object.freeze(readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort());
  return names;
}

/** The text of one migration file, read once. */
export function migrationText(name: string): string {
  let text = texts.get(name);
  if (text === undefined) {
    text = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    texts.set(name, text);
  }
  return text;
}

/** The texts of every migration, in apply order (for checks that need all of them). */
export function allMigrationTexts(): string[] {
  return migrationNames().map(migrationText);
}

type Match = string | ((sql: string) => boolean);

/** The latest migration (name and text) whose text contains `match` (or passes it), or undefined when none does. */
export function latestMigration(match: Match): { name: string; sql: string } | undefined {
  const test = typeof match === "string" ? (sql: string) => sql.includes(match) : match;
  const list = migrationNames();
  for (let i = list.length - 1; i >= 0; i--) {
    const sql = migrationText(list[i]);
    if (test(sql)) return { name: list[i], sql };
  }
  return undefined;
}

/** The text of the latest migration whose text contains `match` (or passes it), or undefined when none does. */
export function latestMigrationText(match: Match): string | undefined {
  return latestMigration(match)?.sql;
}

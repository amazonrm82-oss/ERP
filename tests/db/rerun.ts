import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A test that re-runs an older migration puts back that migration's function bodies. Every later migration that
// redefines one of them must run again after it, and so must every later migration that redefines a function of
// THOSE files, and so on (a closure), or the tests that run afterwards see an old body. The global teardown
// (tests/db/global-setup.ts) proves it: every function body must be the one a fresh build made.

export const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

const FUNCTION_NAME = /create\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/gi;

/** The schema-qualified names of the functions a migration creates or replaces, lower case. */
export function definedFunctions(sql: string): Set<string> {
  return new Set([...sql.matchAll(FUNCTION_NAME)].map((m) => m[1].toLowerCase()));
}

// grant/revoke … on [table] public.<t>: the tables whose client grants a migration sets. "on function", "on schema" and
// "on all tables in schema" do not match (no schema-qualified name right after "on [table]"); a list "on public.a,
// public.b" names every table in it.
const GRANT_TABLE =
  /\b(?:grant|revoke)\b[^;]*?\bon\s+(?:table\s+)?(public\.[a-z_][a-z0-9_]*(?:\s*,\s*public\.[a-z_][a-z0-9_]*)*)\b(?!\s*\()/gi;

/** The public tables a migration grants or revokes client rights on, lower case. */
export function grantedTables(sql: string): Set<string> {
  return new Set([...sql.matchAll(GRANT_TABLE)].flatMap((m) => m[1].toLowerCase().split(/\s*,\s*/)));
}

/** The migration file whose name ends with this suffix (the number changes when the lead renumbers it). */
export function migrationFile(suffix: string): string {
  const file = readdirSync(MIGRATIONS_DIR).find((f) => f.endsWith(suffix));
  if (!file) throw new Error(`migration *${suffix} not found`);
  return file;
}

/**
 * The SQL to re-run, in name order: the given migrations, and every migration after the first of them that
 * redefines a function a file already in the list defines (growing as files join, in name order), or that
 * `also` asks for. A file between two given ones is judged by the functions of the files before it.
 * Grants close the same way: a re-run `revoke all … grant (cols)` drops a column grant a later migration added, so every
 * later migration that grants or revokes on a table a file already in the list grants or revokes on joins too.
 */
export function rerunClosure(
  files: string[],
  also: (sql: string) => boolean = () => false,
  dir: string = MIGRATIONS_DIR,
): { files: string[]; sql: string[] } {
  const start = new Set(files);
  const first = [...files].sort()[0];
  const names = new Set<string>();
  const tables = new Set<string>();
  const picked: string[] = [];
  const texts: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f >= first).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const defines = definedFunctions(sql);
    const grants = grantedTables(sql);
    if (start.has(file) || [...defines].some((name) => names.has(name)) || [...grants].some((t) => tables.has(t)) || also(sql)) {
      picked.push(file);
      texts.push(sql);
      for (const name of defines) names.add(name);
      for (const t of grants) tables.add(t);
    }
  }
  const missing = files.filter((file) => !picked.includes(file));
  if (missing.length > 0) throw new Error(`migrations not found: ${missing.join(", ")}`);
  return { files: picked, sql: texts };
}

/**
 * For a hand-picked list of migrations re-run in the given order: every function they define whose last body in the
 * list is not its latest body among all migrations, as "name: list ends with <file>, latest is <file>". Empty when the
 * list leaves every function it touches as a fresh build made it. A test that keeps such a list asserts this is empty,
 * so a newer migration that redefines one of its functions fails the test by name, not at teardown.
 */
export function staleRestores(files: string[], dir: string = MIGRATIONS_DIR): string[] {
  const lastInList = new Map<string, string>();
  for (const file of files) {
    for (const name of definedFunctions(readFileSync(join(dir, file), "utf8"))) lastInList.set(name, file);
  }
  const latest = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const name of definedFunctions(readFileSync(join(dir, file), "utf8"))) {
      if (lastInList.has(name)) latest.set(name, file);
    }
  }
  return [...lastInList]
    .filter(([name, file]) => latest.get(name) !== file)
    .map(([name, file]) => `${name}: list ends with ${file}, latest is ${latest.get(name)}`);
}

// revoke <privileges> on [table] public.<t> with no column list (`revoke all …`, `revoke insert, update …`): a table-level
// revoke also drops every column grant of those privileges a later migration added to that table. A column revoke,
// `revoke insert (x) …`, has a parenthesis in its privilege list and does not match.
const REVOKE_TABLE_LEVEL =
  /\brevoke\s+(?!grant\s+option)[a-z_,\s]+?\s+on\s+(?:table\s+)?(public\.[a-z_][a-z0-9_]*(?:\s*,\s*public\.[a-z_][a-z0-9_]*)*)\b(?!\s*\()/gi;

/**
 * For a hand-picked list of migrations re-run in the given order: every later migration (by name) that grants or revokes
 * on a table one of the listed files revokes on at table level (no column list), but is not in the list, as
 * "<file> (<table>)". A re-run of such a `revoke … grant (cols)` drops that migration's grants, so the list must re-run it
 * too. Empty when the list puts back every grant it drops. (Column revokes, `revoke insert (x) …`, drop only their own
 * columns and are not counted.)
 */
export function staleGrants(files: string[], dir: string = MIGRATIONS_DIR): string[] {
  const firstRevoke = new Map<string, string>();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(REVOKE_TABLE_LEVEL)) {
      for (const table of m[1].toLowerCase().split(/\s*,\s*/)) {
        if (!firstRevoke.has(table) || file < firstRevoke.get(table)!) firstRevoke.set(table, file);
      }
    }
  }
  const out: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (files.includes(file)) continue;
    for (const table of grantedTables(readFileSync(join(dir, file), "utf8"))) {
      const first = firstRevoke.get(table);
      if (first !== undefined && file > first) out.push(`${file} (${table})`);
    }
  }
  return out;
}

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// A test that re-runs an older migration puts back that migration's function bodies. Every later migration that
// redefines one of them must run again after it, and so must every later migration that redefines a function of
// THOSE files, and so on (a closure), or the tests that run afterwards see an old body. The global teardown
// (tests/db/global-setup.ts) proves it: every function body, policy, RLS switch, grant (table, column, function), trigger
// and constraint must be the one a fresh build made.

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

// create / alter policy <name> on <schema>.<table>: the policies a migration sets (a `create policy` inside an
// "if not exists" block counts too, which can only add files, never miss one). Policies made from a format string in a
// `do` loop (0004's generic ones) have no literal name and are not seen.
const POLICY = /\b(?:create|alter)\s+policy\s+"?([a-z_][a-z0-9_]*)"?\s+on\s+(?:table\s+)?([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)/gi;

/** The policies a migration creates or alters, as "<schema>.<table> <policy>", lower case. */
export function definedPolicies(sql: string): Set<string> {
  return new Set([...sql.matchAll(POLICY)].map((m) => `${m[2].toLowerCase()} ${m[1].toLowerCase()}`));
}

// create [unique] index [if not exists] <name> / drop index [if exists] [public.]<name>: an index a migration makes, and one
// a later migration removes (QUO-09: 20261006021123 removes 020955's files_quote_pdf_one, which a re-run of 020955 brings back)
const INDEX_CREATE = /\bcreate\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
const INDEX_DROP = /\bdrop\s+index\s+(?:concurrently\s+)?(?:if\s+exists\s+)?(?:[a-z_][a-z0-9_]*\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/** The indexes a migration creates, lower case. */
export function createdIndexes(sql: string): Set<string> {
  return new Set([...sql.matchAll(INDEX_CREATE)].map((m) => m[1].toLowerCase()));
}

/** The indexes a migration drops, lower case. */
export function droppedIndexes(sql: string): Set<string> {
  return new Set([...sql.matchAll(INDEX_DROP)].map((m) => m[1].toLowerCase()));
}

// add constraint <name>: a constraint a migration (re)sets. A re-run of an older `drop constraint if exists … add constraint`
// puts back its older check (PKG-03: re-running 020390 or 020100 put back the notification kinds without punch_card), so
// every later migration that adds a constraint of the same name joins. Matched by name alone, which can only add files.
const CONSTRAINT_ADD = /\badd\s+constraint\s+"?([a-z_][a-z0-9_]*)"?/gi;

/** The constraints a migration adds, lower case. */
export function addedConstraints(sql: string): Set<string> {
  return new Set([...sql.matchAll(CONSTRAINT_ADD)].map((m) => m[1].toLowerCase()));
}

// create [or replace] trigger <name>: a trigger a migration (re)sets. A re-run of an older `create or replace trigger` puts
// back its older events or WHEN clause (BIZ-01 (316): re-running 021237 put back business_pages_audit on update), so every
// later migration that creates a trigger of the same name joins. Matched by name alone, which can only add files.
const TRIGGER_CREATE = /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+"?([a-z_][a-z0-9_]*)"?/gi;

/** The triggers a migration creates, lower case. */
export function createdTriggers(sql: string): Set<string> {
  return new Set([...sql.matchAll(TRIGGER_CREATE)].map((m) => m[1].toLowerCase()));
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
 * Policies too: a re-run `alter policy` / `drop … create policy` puts back an old USING or WITH CHECK, so every later
 * migration that creates or alters a policy a file already in the list sets joins.
 * Indexes too: a re-run `create index if not exists` brings back an index a later migration dropped, so every later
 * migration that drops an index a file already in the list creates joins.
 * Constraints too: a re-run `drop constraint if exists … add constraint` puts back an older check, so every later
 * migration that adds a constraint of a name a file already in the list adds joins.
 * Triggers too: a re-run `create or replace trigger` puts back older events or WHEN, so every later migration that creates
 * a trigger of a name a file already in the list creates joins.
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
  const policies = new Set<string>();
  const indexes = new Set<string>();
  const constraints = new Set<string>();
  const triggers = new Set<string>();
  const picked: string[] = [];
  const texts: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f >= first).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const defines = definedFunctions(sql);
    const grants = grantedTables(sql);
    const sets = definedPolicies(sql);
    const drops = droppedIndexes(sql);
    const adds = addedConstraints(sql);
    const made = createdTriggers(sql);
    if (
      start.has(file) ||
      [...defines].some((name) => names.has(name)) ||
      [...grants].some((t) => tables.has(t)) ||
      [...sets].some((p) => policies.has(p)) ||
      [...drops].some((i) => indexes.has(i)) ||
      [...adds].some((c) => constraints.has(c)) ||
      [...made].some((t) => triggers.has(t)) ||
      also(sql)
    ) {
      picked.push(file);
      texts.push(sql);
      for (const name of defines) names.add(name);
      for (const t of grants) tables.add(t);
      for (const p of sets) policies.add(p);
      for (const i of createdIndexes(sql)) indexes.add(i);
      for (const c of adds) constraints.add(c);
      for (const t of made) triggers.add(t);
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

/**
 * For a hand-picked list of migrations re-run in the given order: every policy they create or alter whose last definition
 * in the list is not its latest among all migrations, as "<table> <policy>: list ends with <file>, latest is <file>". The
 * policy twin of staleRestores; a test that keeps such a list asserts this is empty too.
 */
export function stalePolicies(files: string[], dir: string = MIGRATIONS_DIR): string[] {
  const lastInList = new Map<string, string>();
  for (const file of files) {
    for (const policy of definedPolicies(readFileSync(join(dir, file), "utf8"))) lastInList.set(policy, file);
  }
  const latest = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    for (const policy of definedPolicies(readFileSync(join(dir, file), "utf8"))) {
      if (lastInList.has(policy)) latest.set(policy, file);
    }
  }
  return [...lastInList]
    .filter(([policy, file]) => latest.get(policy) !== file)
    .map(([policy, file]) => `${policy}: list ends with ${file}, latest is ${latest.get(policy)}`);
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

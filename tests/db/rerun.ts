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
 */
export function rerunClosure(
  files: string[],
  also: (sql: string) => boolean = () => false,
  dir: string = MIGRATIONS_DIR,
): { files: string[]; sql: string[] } {
  const start = new Set(files);
  const first = [...files].sort()[0];
  const names = new Set<string>();
  const picked: string[] = [];
  const texts: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql") && f >= first).sort()) {
    const sql = readFileSync(join(dir, file), "utf8");
    const defines = definedFunctions(sql);
    if (start.has(file) || [...defines].some((name) => names.has(name)) || also(sql)) {
      picked.push(file);
      texts.push(sql);
      for (const name of defines) names.add(name);
    }
  }
  const missing = files.filter((file) => !picked.includes(file));
  if (missing.length > 0) throw new Error(`migrations not found: ${missing.join(", ")}`);
  return { files: picked, sql: texts };
}

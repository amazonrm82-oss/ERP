import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { definedFunctions, rerunClosure } from "../db/rerun";

// tests/db/rerun.ts: which later migrations a test re-runs after an older one (the closure).
describe("rerunClosure", () => {
  const dir = mkdtempSync(join(tmpdir(), "rerun-closure-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "0100_a.sql": "create or replace function app.alpha() returns int language sql as $$ select 1 $$;",
    // between the two start files: redefines a function of the first one
    "0150_b.sql": "create or replace function app.alpha() returns int language sql as $$ select 2 $$;\ncreate function public.beta(x int) returns int language sql as $$ select x $$;",
    "0200_c.sql": "create or replace function app.gamma() returns int language sql as $$ select 3 $$;",
    // defines nothing in the set: skipped
    "0250_d.sql": "create or replace function app.delta() returns int language sql as $$ select 4 $$;",
    // redefines a function brought in by 0150 (the set grows)
    "0300_e.sql": "create or replace function public.beta(x int) returns int language sql as $$ select x + 1 $$;",
    "0400_f.sql": "create or replace function app.gamma() returns int language sql as $$ select 5 $$;",
    "0500_g.sql": "grant select on public.things to authenticated;",
    "0050_z.sql": "create or replace function app.alpha() returns int language sql as $$ select 0 $$;",
  };
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);

  it("reads the functions a migration defines", () => {
    expect([...definedFunctions(files["0150_b.sql"])].sort()).toEqual(["app.alpha", "public.beta"]);
  });

  it("scans everything after the first start file, in name order, and grows the set", () => {
    expect(rerunClosure(["0200_c.sql", "0100_a.sql"], undefined, dir).files).toEqual(["0100_a.sql", "0150_b.sql", "0200_c.sql", "0300_e.sql", "0400_f.sql"]);
    // one start file: an earlier file is never picked, nor one that touches nothing in the set
    expect(rerunClosure(["0200_c.sql"], undefined, dir).files).toEqual(["0200_c.sql", "0400_f.sql"]);
    // "also" picks a file by its text
    expect(rerunClosure(["0200_c.sql"], (sql) => sql.includes("grant select on public.things"), dir).files).toEqual(["0200_c.sql", "0400_f.sql", "0500_g.sql"]);
    expect(() => rerunClosure(["0999_none.sql"], undefined, dir)).toThrow(/not found/);
  });
});

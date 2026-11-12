import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createdTriggers, definedFunctions, definedPolicies, rerunClosure, stalePolicies } from "../db/rerun";

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

// Policies close the same way: a re-run `alter policy` puts back an old USING / WITH CHECK (the teardown compares them too).
describe("rerunClosure and stalePolicies over policies", () => {
  const dir = mkdtempSync(join(tmpdir(), "rerun-policies-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "0100_a.sql": "create policy things_select on public.things for select to authenticated using (true);",
    // another policy of the same table: not in the set
    "0150_b.sql": "create policy things_insert on public.things for insert to authenticated with check (true);",
    // alters a policy of the first file (quoted name, storage schema elsewhere)
    "0200_c.sql": 'alter policy "things_select" on public.things using (false);\ncreate policy files_delete on storage.objects for delete using (true);',
    "0300_d.sql": "alter policy files_delete on storage.objects using (false);",
  };
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);

  it("reads the policies a migration creates or alters", () => {
    expect([...definedPolicies(files["0200_c.sql"])].sort()).toEqual(["public.things things_select", "storage.objects files_delete"]);
  });

  it("brings in every later file that sets a policy of the set", () => {
    expect(rerunClosure(["0100_a.sql"], undefined, dir).files).toEqual(["0100_a.sql", "0200_c.sql", "0300_d.sql"]);
    expect(rerunClosure(["0150_b.sql"], undefined, dir).files).toEqual(["0150_b.sql"]);
  });

  it("names a policy a hand-picked list leaves at an older definition", () => {
    expect(stalePolicies(["0100_a.sql"], dir)).toEqual(["public.things things_select: list ends with 0100_a.sql, latest is 0200_c.sql"]);
    expect(stalePolicies(["0100_a.sql", "0200_c.sql"], dir)).toEqual(["storage.objects files_delete: list ends with 0200_c.sql, latest is 0300_d.sql"]);
    expect(stalePolicies(["0100_a.sql", "0200_c.sql", "0300_d.sql"], dir)).toEqual([]);
  });
});

// Triggers close the same way: a re-run `create or replace trigger` puts back older events or WHEN (BIZ-01 (316)).
describe("rerunClosure over triggers", () => {
  const dir = mkdtempSync(join(tmpdir(), "rerun-triggers-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "0100_a.sql": "create or replace trigger things_audit after insert or update or delete on public.things for each row execute function app.audit_row();",
    "0150_b.sql": "create trigger other_touch before update on public.other for each row execute function app.touch_row();",
    "0200_c.sql": 'create or replace trigger "things_audit" after insert or delete on public.things for each row execute function app.audit_row();',
    "0300_d.sql": "create constraint trigger other_touch after update on public.other deferrable initially deferred for each row execute function app.x();",
  };
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);

  it("reads the triggers a migration creates", () => {
    expect([...createdTriggers(files["0200_c.sql"])]).toEqual(["things_audit"]);
    expect([...createdTriggers(files["0300_d.sql"])]).toEqual(["other_touch"]);
  });

  it("brings in every later file that creates a trigger of the set", () => {
    expect(rerunClosure(["0100_a.sql"], undefined, dir).files).toEqual(["0100_a.sql", "0200_c.sql"]);
    expect(rerunClosure(["0150_b.sql"], undefined, dir).files).toEqual(["0150_b.sql", "0300_d.sql"]);
  });
});

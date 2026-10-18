import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

// FXD-08 part two: pg_net moves from schema public to schema extensions by a hand-pasted file
// (supabase/manual/fxd08_pg_net_move.sql). Its functions stay in schema `net`, so our callers keep working as long as
// they call net.http_*() by that qualified name and look for the extension only by name. These tests pin who calls
// pg_net and how; a new caller must follow the same rule.
describe("pg_net callers (FXD-08)", () => {
  it("only app.dispatch_push and app.cleanup_files call pg_net, each as net.http_post(...)", async () => {
    const rows = await asAdmin(
      async (q) =>
        (
          await q<{ name: string; calls: number; qualified: number; other_schema: boolean }>(
            `select n.nspname || '.' || p.proname as name,
                    (select count(*) from regexp_matches(p.prosrc, 'http_(post|get|delete|request)', 'g'))::int as calls,
                    (select count(*) from regexp_matches(p.prosrc, 'net\\.http_post\\(', 'g'))::int as qualified,
                    p.prosrc ~* '(public|extensions)\\.http_' as other_schema
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('app', 'public') and p.prosrc ~* 'http_(post|get|delete|request)'
              order by 1`,
          )
        ).rows,
    );
    expect(rows).toEqual([
      { name: "app.cleanup_files", calls: 1, qualified: 1, other_schema: false },
      { name: "app.dispatch_push", calls: 1, qualified: 1, other_schema: false },
    ]);
  });

  it("the callers look for the extension by name only, never by its schema", async () => {
    const bodies = await asAdmin(
      async (q) =>
        (await q<{ src: string }>("select p.prosrc as src from pg_proc p where p.oid in ('app.dispatch_push()'::regprocedure, 'app.cleanup_files()'::regprocedure)")).rows,
    );
    for (const { src } of bodies) {
      expect(src).toContain("extname = 'pg_net'");
      expect(src).not.toMatch(/extnamespace/);
    }
  });

  it("the move and rollback files do nothing where pg_net is not installed", async () => {
    for (const file of ["fxd08_pg_net_move.sql", "fxd08_pg_net_rollback.sql"]) {
      const sql = readFileSync(join(process.cwd(), "supabase/manual", file), "utf8");
      await asAdmin(async (q) => {
        await q(sql);
      });
    }
    const installed = await asAdmin(async (q) => (await q("select 1 from pg_extension where extname = 'pg_net'")).rowCount);
    expect(installed).toBe(0);
  });
});

import { afterAll, describe, expect, it } from "vitest";

import { asAdmin, closePool } from "./helpers";

afterAll(closePool);

// FXD-08 part one: every table of ours has a primary key (app.mfa_recovery_attempts was the last without one, 020350).
describe("primary keys", () => {
  it("every table in schemas app and public has one", async () => {
    const missing = await asAdmin(
      async (q) =>
        (
          await q<{ name: string }>(
            `select n.nspname || '.' || c.relname as name
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind in ('r', 'p') and n.nspname in ('app', 'public')
                and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')
              order by 1`,
          )
        ).rows.map((row) => row.name),
    );
    expect(missing).toEqual([]);
  });

  it("the backup-code attempts get their key from the database", async () => {
    const row = await asAdmin(async (q) => {
      const user = (await q<{ id: string }>("insert into auth.users (id, email) values (gen_random_uuid(), 'pk-' || gen_random_uuid() || '@example.test') returning id")).rows[0].id;
      await q("insert into app.mfa_recovery_attempts (user_id) values ($1), ($1)", [user]);
      return (await q<{ n: string; distinct_ids: string }>("select count(*) as n, count(distinct id) as distinct_ids from app.mfa_recovery_attempts where user_id = $1", [user])).rows[0];
    });
    expect(row).toEqual({ n: "2", distinct_ids: "2" });
  });
});

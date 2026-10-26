import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * CNS-06 follow-up (owner, 26 October 2026): a job made before the blocked-addresses count existed reads
 * consents_locked_counted = false (the column's first default); every job made since reads true. Server only.
 */
describe("which imports counted their blocked addresses (CNS-06)", () => {
  let owner: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("lc-owner");
    org = await createOrg(owner.id, "עסק ספירה");
  });

  const newJob = (fields: Record<string, unknown> = {}) =>
    asUser(owner.id, async (q) => {
      const row: Record<string, unknown> = { organization_id: org, entity_type: "lead", file_name: "x.csv", duplicate_mode: "skip", ...fields };
      const cols = Object.keys(row);
      return (
        await q<{ id: string }>(
          `insert into public.import_jobs (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
          Object.values(row),
        )
      ).rows[0].id;
    });

  it("a new job is counted; the column's default is true and it is not null", async () => {
    const job = await newJob();
    const counted = await asUser(owner.id, async (q) =>
      (await q<{ c: boolean }>("select consents_locked_counted as c from public.import_jobs where id = $1", [job])).rows[0].c,
    );
    expect(counted).toBe(true);
    const column = await asAdmin(
      async (q) =>
        (
          await q<{ d: string; n: string }>(
            "select column_default as d, is_nullable as n from information_schema.columns where table_schema = 'public' and table_name = 'import_jobs' and column_name = 'consents_locked_counted'",
          )
        ).rows[0],
    );
    expect(column).toEqual({ d: "true", n: "NO" });
  });

  it("a client never writes it, on insert or update", async () => {
    expect((await pgError(newJob({ consents_locked_counted: false }))).code).toBe("42501");
    const job = await newJob();
    expect((await pgError(asUser(owner.id, (q) => q("update public.import_jobs set consents_locked_counted = false where id = $1", [job])))).code).toBe("42501");
  });
});

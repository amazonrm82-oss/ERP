import { readdirSync, readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asService, asUser, closePool, count, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

/**
 * TAX-06 follow-up: a business's currency is ILS only until DEAL-12, like every amount table, so an owner or admin can no
 * longer set another one through the API, and adding sample data (whose deal takes the business's currency) cannot fail.
 */
describe("a business's currency is ILS only (TAX-06)", () => {
  let owner: U, admin: U;
  let org: string;

  beforeAll(async () => {
    owner = await createUser("cur-owner");
    org = await createOrg(owner.id, "עסק בשקלים");
    admin = await addMember(org, owner.id, "admin", "cur-admin");
  });

  it("the check exists and is validated", async () => {
    const row = await asAdmin(async (q) =>
      (
        await q<{ def: string; validated: boolean }>(
          "select pg_get_constraintdef(oid) as def, convalidated as validated from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_currency_ils'",
        )
      ).rows[0],
    );
    expect(row.validated).toBe(true);
    expect(row.def).toContain("'ILS'");
  });

  it("an owner, an admin and the server cannot set another currency; ILS stays writable", async () => {
    for (const as of [owner, admin]) {
      const err = await pgError(asUser(as.id, (q) => q("update public.organizations set currency = 'USD' where id = $1", [org])));
      expect(err.code, as.email).toBe("23514");
    }
    expect((await pgError(asService((q) => q("update public.organizations set currency = 'EUR' where id = $1", [org])))).code).toBe("23514");
    const updated = await asUser(owner.id, async (q) => (await q("update public.organizations set currency = 'ILS' where id = $1 returning id", [org])).rowCount);
    expect(updated).toBe(1);
    expect(await asAdmin((q) => count(q, "select 1 from public.organizations where id = $1 and currency = 'ILS'", [org]))).toBe(1);
  });

  it("sample data is added in shekels", async () => {
    await asUser(owner.id, (q) => q("select public.sample_data_add($1)", [org]));
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where organization_id = $1", [org]))).toBeGreaterThan(0);
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where organization_id = $1 and currency <> 'ILS'", [org]))).toBe(0);
  });

  it("the migration adds the check only when it is missing (safe to run twice)", async () => {
    const file = readdirSync("supabase/migrations").find((f) => f.endsWith("_organizations_currency_ils.sql"))!;
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    await asAdmin((q) => q(sql));
    expect(
      await asAdmin((q) => count(q, "select 1 from pg_constraint where conrelid = 'public.organizations'::regclass and conname = 'organizations_currency_ils'")),
    ).toBe(1);
  });
});

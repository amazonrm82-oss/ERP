import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asMfaUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

const makeStaff = (userId: string, role: string) =>
  asAdmin((q) => q("insert into app.platform_staff (user_id, role) values ($1, $2) on conflict (user_id) do update set role = excluded.role", [userId, role]));

const planOf = (org: string) =>
  asAdmin(async (q) => (await q<{ plan_key: string; seats: number | null }>("select plan_key, seats from public.subscriptions where organization_id = $1", [org])).rows[0]);

// Owner, 8 October 2026: the free plan is cancelled. Its row stays, hidden, and no
// business may be moved onto a hidden plan; one already on it may keep it.
describe("hidden free plan", () => {
  let finance: { id: string };
  let org: string;

  beforeAll(async () => {
    finance = await createUser("hide-finance");
    await makeStaff(finance.id, "finance");
    const owner = await createUser("hide-owner");
    org = await createOrg(owner.id);
  });

  const update = (planKey: string, seats: number | null = null) =>
    asMfaUser(finance.id, (q) =>
      q("select public.platform_update_subscription($1, $2, $3, now() + interval '14 days', 'בדיקה')", [org, planKey, seats]),
    );

  it("the free plan is hidden, its row and features kept", async () => {
    const free = await asAdmin(
      async (q) => (await q<{ is_public: boolean; quotes: boolean }>("select is_public, (features ->> 'quotes')::boolean as quotes from public.plans where key = 'free'")).rows[0],
    );
    expect(free).toEqual({ is_public: false, quotes: false });
    const shown = await asAdmin(async (q) => (await q<{ key: string }>("select key from public.plans where is_public order by position")).rows.map((r) => r.key));
    expect(shown).toEqual(["personal", "basic", "pro"]);
  });

  it("staff cannot move a business onto a hidden plan", async () => {
    const err = await pgError(update("free"));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("plan:hidden");
    expect((await planOf(org)).plan_key).toBe("pro");
  });

  it("a business already on a hidden plan may keep it, and still move to a public one", async () => {
    await asAdmin((q) => q("update public.subscriptions set plan_key = 'free' where organization_id = $1", [org]));
    await update("free", 3);
    expect(await planOf(org)).toEqual({ plan_key: "free", seats: 3 });
    await update("basic");
    expect((await planOf(org)).plan_key).toBe("basic");
    expect((await pgError(update("free"))).hint).toBe("plan:hidden");
  });

  it("running the migration again changes no row", async () => {
    const dir = join(process.cwd(), "supabase/migrations");
    const file = readdirSync(dir).find((name) => name.endsWith("_hide_free_plan.sql"));
    const sql = readFileSync(join(dir, file as string), "utf8");
    const statement = /^update public\.plans[^;]*;/m.exec(sql)?.[0];
    expect(statement).toBeDefined();
    const changed = await asAdmin(async (q) => (await q(statement as string)).rowCount);
    expect(changed).toBe(0);
  });
});

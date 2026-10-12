import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// USR-03: organizations.setup_step keeps where the setup wizard stands (1..4, null = done).
describe("setup wizard progress (USR-03)", () => {
  let owner: U, admin: U, manager: U, member: U, outsider: U;
  let org: string, otherOrg: string;

  const step = (id: string) =>
    asAdmin(async (q) => (await q<{ s: number | null }>("select setup_step as s from public.organizations where id = $1", [id])).rows[0].s);
  const setStep = (userId: string, id: string, value: number | null) =>
    asUser(userId, (q) => q("update public.organizations set setup_step = $2 where id = $1 returning id", [id, value]));

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    admin = await addMember(org, owner.id, "admin");
    manager = await addMember(org, owner.id, "manager");
    member = await addMember(org, owner.id, "member");
    outsider = await createUser("outsider");
    otherOrg = await createOrg(outsider.id, "עסק אחר");
  });

  it("a new organization starts at step 1; the column default is 1", async () => {
    expect(await step(org)).toBe(1);
    const def = await asAdmin(async (q) =>
      (
        await q<{ d: string | null; n: string }>(
          `select column_default as d, is_nullable as n from information_schema.columns
            where table_schema = 'public' and table_name = 'organizations' and column_name = 'setup_step'`,
        )
      ).rows[0],
    );
    expect(def.d).toBe("1");
    expect(def.n).toBe("YES");
  });

  it("the owner and an admin move it forward and finish it", async () => {
    expect((await setStep(owner.id, org, 2)).rowCount).toBe(1);
    expect(await step(org)).toBe(2);
    expect((await setStep(admin.id, org, 4)).rowCount).toBe(1);
    expect(await step(org)).toBe(4);
    expect((await setStep(admin.id, org, null)).rowCount).toBe(1);
    expect(await step(org)).toBeNull();
    // and can start it again
    expect((await setStep(owner.id, org, 1)).rowCount).toBe(1);
  });

  it("a manager or a member cannot change it, nor can anyone in another organization", async () => {
    expect((await setStep(manager.id, org, 3)).rowCount).toBe(0);
    expect((await setStep(member.id, org, null)).rowCount).toBe(0);
    expect((await setStep(outsider.id, org, 3)).rowCount).toBe(0);
    expect(await step(org)).toBe(1);
    // an update without WHERE touches only the caller's own organization
    await asUser(owner.id, (q) => q("update public.organizations set setup_step = 3"));
    expect(await step(org)).toBe(3);
    expect(await step(otherOrg)).toBe(1);
  });

  it("anon has no access", async () => {
    const err = await pgError(asAnon((q) => q("update public.organizations set setup_step = 2 where id = $1", [org])));
    expect(err.code).toBe("42501");
  });

  it("only steps 1 to 4 are accepted", async () => {
    expect((await pgError(setStep(owner.id, org, 5))).code).toBe("23514");
    expect((await pgError(setStep(owner.id, org, 0))).code).toBe("23514");
  });

  it("the change is in the audit log like any other change of the business details", async () => {
    await setStep(owner.id, org, 2);
    const entry = await asAdmin(async (q) =>
      (
        await q<{ changes: Record<string, { old: unknown; new: unknown }>; actor_id: string }>(
          `select changes, actor_id from public.audit_log
            where organization_id = $1 and entity_type = 'organizations' and changes ? 'setup_step'
            order by created_at desc, id desc limit 1`,
          [org],
        )
      ).rows[0],
    );
    expect(entry.actor_id).toBe(owner.id);
    expect(entry.changes.setup_step.new).toBe(2);
  });

  it("the app's forward-only write never moves progress back and leaves a finished wizard alone", async () => {
    await setStep(owner.id, org, 3);
    // what writeProgress() sends after step 1: set 2 only where the stored step is below 2
    const back = await asUser(owner.id, (q) => q("update public.organizations set setup_step = 2 where id = $1 and setup_step < 2 returning id", [org]));
    expect(back.rowCount).toBe(0);
    expect(await step(org)).toBe(3);
    const forward = await asUser(owner.id, (q) => q("update public.organizations set setup_step = 4 where id = $1 and setup_step < 4 returning id", [org]));
    expect(forward.rowCount).toBe(1);
    await setStep(owner.id, org, null);
    const finished = await asUser(owner.id, (q) => q("update public.organizations set setup_step = 2 where id = $1 and setup_step < 2 returning id", [org]));
    expect(finished.rowCount).toBe(0);
    expect(await step(org)).toBeNull();
  });

  it("running the migration again keeps every stored value (rows from before it stay null)", async () => {
    await setStep(owner.id, org, null);
    await setStep(outsider.id, otherOrg, 3);
    // found by name, so the number the migration gets at merge does not matter
    const dir = path.resolve(__dirname, "../../supabase/migrations");
    const file = readdirSync(dir).find((f) => f.endsWith("_setup_wizard.sql"));
    expect(file).toBeDefined();
    const sql = readFileSync(path.join(dir, file as string), "utf8");
    await asAdmin((q) => q(sql));
    expect(await step(org)).toBeNull();
    expect(await step(otherOrg)).toBe(3);
    // new organizations still start at step 1
    expect(await step(await createOrg(outsider.id, "עסק שלישי"))).toBe(1);
  });
});

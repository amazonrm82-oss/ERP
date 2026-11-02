import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAdmin, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

/** HEB-09: one switch per business; app.customer_sending_paused is the one rule every automatic customer sender asks. */
describe("sending pause (HEB-09)", () => {
  let owner: { id: string };
  let other: { id: string };
  let org: string;
  let otherOrg: string;
  const paused = (o: string) => asAdmin(async (q) => (await q<{ p: boolean }>("select app.customer_sending_paused($1) as p", [o])).rows[0].p);

  beforeAll(async () => {
    owner = await createUser("pause-owner");
    other = await createUser("pause-other");
    org = await createOrg(owner.id);
    otherOrg = await createOrg(other.id);
  });

  it("no row = not paused; a pause holds for its own business only; resuming lifts it", async () => {
    expect(await paused(org)).toBe(false);
    await asUser(owner.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'יום אבל')", [org]));
    expect(await paused(org)).toBe(true);
    expect(await paused(otherOrg)).toBe(false);
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = false, reason = null where organization_id = $1", [org]));
    expect(await paused(org)).toBe(false);
  });

  it("nobody but the server asks the rule, and no client reaches it", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const can = await asAdmin(async (q) => (await q<{ c: boolean }>("select has_function_privilege($1, 'app.customer_sending_paused(uuid)', 'execute') as c", [role])).rows[0].c);
      expect(can, role).toBe(false);
    }
    expect((await pgError(asUser(owner.id, (q) => q("select app.customer_sending_paused($1)", [org])))).code).toBe("42501");
  });

  it("an outsider neither reads nor pauses another business", async () => {
    expect(await asUser(other.id, async (q) => (await q("select 1 from public.org_sending_pauses where organization_id = $1", [org])).rowCount)).toBe(0);
    expect((await pgError(asUser(other.id, (q) => q("insert into public.org_sending_pauses (organization_id, paused, reason) values ($1, true, 'x')", [org])))).code).toBe("42501");
    expect(await asUser(other.id, async (q) => (await q("update public.org_sending_pauses set paused = true, reason = 'x' where organization_id = $1", [org])).rowCount)).toBe(0);
    expect(await paused(org)).toBe(false);
  });

  it("every pause and resume is in the audit log with its reason", async () => {
    await asUser(owner.id, (q) => q("update public.org_sending_pauses set paused = true, reason = 'חירום' where organization_id = $1", [org]));
    const entries = await asAdmin(async (q) =>
      (await q<{ action: string }>("select action from public.audit_log where organization_id = $1 and entity_type = 'org_sending_pauses' order by created_at", [org])).rows,
    );
    expect(entries.length).toBeGreaterThanOrEqual(3);
    const last = await asAdmin(async (q) =>
      (await q<{ c: unknown }>("select changes as c from public.audit_log where organization_id = $1 and entity_type = 'org_sending_pauses' order by id desc limit 1", [org])).rows[0].c,
    );
    expect(JSON.stringify(last)).toContain("חירום");
  });
});

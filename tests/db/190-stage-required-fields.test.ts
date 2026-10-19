import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// DEAL-05 (owner, 18 October 2026, answer (א)): a stage may require the deal's amount, expected close date and contact.
// The list lives on the stage (closed list, checked by the database); the move rule itself is app-only (FLD-09).
describe("built-in fields required to enter a stage (DEAL-05)", () => {
  let owner: U, member: U;
  let org: string;
  let stage: string;

  beforeAll(async () => {
    owner = await createUser("sr-owner");
    org = await createOrg(owner.id, "עסק שלבים");
    member = await addMember(org, owner.id, "member", "sr-member");
    stage = (await defaultPipeline(org)).stages.find((s) => s.kind === "open")!.id;
  });

  const requiredOf = () =>
    asAdmin(async (q) => (await q<{ r: string[] }>("select required_fields as r from public.stages where id = $1", [stage])).rows[0].r);

  it("every stage starts with none", async () => {
    expect(await requiredOf()).toEqual([]);
  });

  it("owners and admins set them from the closed list; a member cannot; anything else is refused", async () => {
    expect(await asUser(owner.id, async (q) => (await q("update public.stages set required_fields = array['amount', 'contact_id'] where id = $1", [stage])).rowCount)).toBe(1);
    expect(await requiredOf()).toEqual(["amount", "contact_id"]);
    expect(await asUser(member.id, async (q) => (await q("update public.stages set required_fields = '{}' where id = $1", [stage])).rowCount)).toBe(0);
    expect(await requiredOf()).toEqual(["amount", "contact_id"]);
    const bad = await pgError(asUser(owner.id, (q) => q("update public.stages set required_fields = array['company_id'] where id = $1", [stage])));
    expect(bad.code).toBe("23514");
    expect(await asUser(owner.id, async (q) => (await q("update public.stages set required_fields = array['expected_close_date'] where id = $1", [stage])).rowCount)).toBe(1);
  });

  it("the change is in the audit log of the stage", async () => {
    const changes = await asAdmin(async (q) =>
      (await q<{ changes: Record<string, unknown> }>("select changes from public.audit_log where entity_type = 'stages' and entity_id = $1 order by created_at desc limit 1", [stage])).rows[0]
        ?.changes,
    );
    expect(JSON.stringify(changes)).toContain("required_fields");
  });

  it("the database never refuses a move into the stage: the rule is the app's (automations and imports go on)", async () => {
    const pipeline = await asAdmin(async (q) => (await q<{ p: string }>("select pipeline_id as p from public.stages where id = $1", [stage])).rows[0].p);
    const deal = await asUser(owner.id, async (q) =>
      (await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'בלי תאריך', $2, $3) returning id", [org, pipeline, stage])).rows[0].id,
    );
    expect(deal).toMatch(/^[0-9a-f-]{36}$/);
  });
});

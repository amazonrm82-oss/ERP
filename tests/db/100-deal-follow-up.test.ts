import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, count, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(async () => {
  await closePool();
});

type U = { id: string };

// DEAL-11: deals.previous_deal_id (a follow-up deal points at the deal it continues). Trigger
// deals_previous_check: a person sets it only on insert, to a live deal they read; never changes it later.
describe("follow-up deal link (DEAL-11)", () => {
  let owner: U, member: U, other: U;
  let org: string, otherOrg: string;
  let stage: string, pipeline: string;
  let otherStage: string, otherPipeline: string;

  const newDeal = (userId: string, name: string, previous: string | null = null, orgId?: string) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, previous_deal_id) values ($1, $2, $3, $4, $5) returning id",
          orgId && orgId !== org ? [orgId, name, otherPipeline, otherStage, previous] : [org, name, pipeline, stage, previous],
        )
      ).rows[0].id,
    );
  const previousOf = (id: string) =>
    asAdmin(async (q) => (await q<{ p: string | null }>("select previous_deal_id as p from public.deals where id = $1", [id])).rows[0]?.p);

  beforeAll(async () => {
    owner = await createUser("follow-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "follow-member");
    other = await createUser("follow-other");
    otherOrg = await createOrg(other.id);
    const p = await defaultPipeline(org);
    pipeline = p.pipelineId;
    stage = p.stages.find((s) => s.kind === "open")!.id;
    const o = await defaultPipeline(otherOrg);
    otherPipeline = o.pipelineId;
    otherStage = o.stages.find((s) => s.kind === "open")!.id;
  });

  it("a person creates a follow-up of a deal they read; the old deal lists it", async () => {
    const first = await newDeal(member.id, "פרויקט ראשון");
    const next = await newDeal(member.id, "המשך: פרויקט ראשון", first);
    expect(await previousOf(next)).toBe(first);
    expect(
      await asUser(member.id, (q) => count(q, "select 1 from public.deals where organization_id = $1 and previous_deal_id = $2", [org, first])),
    ).toBe(1);
  });

  it("the link is set once: a person can neither change nor clear it", async () => {
    const a = await newDeal(owner.id, "א");
    const b = await newDeal(owner.id, "ב");
    const next = await newDeal(owner.id, "המשך של א", a);
    const change = await pgError(asUser(owner.id, (q) => q("update public.deals set previous_deal_id = $2 where id = $1", [next, b])));
    expect(change.code).toBe("P0001");
    expect(change.hint).toBe("deal:previous_deal");
    const clear = await pgError(asUser(owner.id, (q) => q("update public.deals set previous_deal_id = null where id = $1", [next])));
    expect(clear.hint).toBe("deal:previous_deal");
    // a person cannot add it to an existing deal either
    const add = await pgError(asUser(owner.id, (q) => q("update public.deals set previous_deal_id = $2 where id = $1", [b, a])));
    expect(add.hint).toBe("deal:previous_deal");
    // sending the same value, and every other edit, still works
    await asUser(owner.id, (q) => q("update public.deals set name = 'המשך 2', previous_deal_id = $2 where id = $1", [next, a]));
    expect(await previousOf(next)).toBe(a);
  });

  it("a deal in the recycle bin cannot be continued", async () => {
    const binned = await newDeal(owner.id, "בסל");
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [binned]));
    const e = await pgError(newDeal(owner.id, "המשך של בסל", binned));
    expect(e.code).toBe("P0001");
    expect(e.hint).toBe("deal:previous_deal");
  });

  it("a person cannot continue a deal they may not read", async () => {
    const hidden = await newDeal(owner.id, "של הבעלים בלבד");
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const e = await pgError(newDeal(member.id, "המשך נסתר", hidden));
      expect(e.code).toBe("P0001");
      expect(e.hint).toBe("deal:previous_deal");
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("a deal of another organization cannot be continued (composite foreign key)", async () => {
    const foreign = await newDeal(other.id, "של עסק אחר", null, otherOrg);
    const e = await pgError(newDeal(owner.id, "המשך זר", foreign));
    // the person cannot read it, so the trigger refuses before the foreign key would
    expect(e.code).toBe("P0001");
    // a server writer is stopped by the foreign key
    const fk = await pgError(
      asAdmin((q) =>
        q("insert into public.deals (organization_id, name, pipeline_id, stage_id, previous_deal_id) values ($1, 'x', $2, $3, $4)", [org, pipeline, stage, foreign]),
      ),
    );
    expect(fk.code).toBe("23503");
  });

  it("a deal is never its own previous deal", async () => {
    const id = await newDeal(owner.id, "עצמי");
    const e = await pgError(asAdmin((q) => q("update public.deals set previous_deal_id = id where id = $1", [id])));
    expect(e.code).toBe("23514");
  });

  it("purging the earlier deal clears only the link", async () => {
    const first = await newDeal(owner.id, "יימחק");
    const next = await newDeal(owner.id, "נשאר", first);
    await asUser(owner.id, (q) => q("update public.deals set deleted_at = now() where id = $1", [first]));
    await asUser(owner.id, (q) => q("delete from public.deals where id = $1", [first]));
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1", [first]))).toBe(0);
    expect(await previousOf(next)).toBeNull();
    expect(await asAdmin((q) => count(q, "select 1 from public.deals where id = $1 and organization_id = $2", [next, org]))).toBe(1);
  });

  it("a viewer cannot create a follow-up", async () => {
    const viewer = await addMember(org, owner.id, "viewer", "follow-viewer");
    const first = await newDeal(owner.id, "לצפייה");
    const e = await pgError(newDeal(viewer.id, "המשך של צופה", first));
    expect(e.code).toBe("42501");
  });
});

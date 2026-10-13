import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type DealState = { status: string; closed_at: Date | null; amount_agorot: number };

// DEAL-04: the close window writes the amount and the close date with the move into a won stage.
describe("deal close window (DEAL-04)", () => {
  let owner: U, member: U;
  let org: string;
  let pipelineId: string, openStage: string, wonStage: string, lostStage: string;

  const newDeal = (userId: string, stageId: string) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>("insert into public.deals (organization_id, name, pipeline_id, stage_id) values ($1, 'עסקה', $2, $3) returning id", [
          org,
          pipelineId,
          stageId,
        ])
      ).rows[0].id,
    );

  const readDeal = (id: string) =>
    asAdmin(async (q) => (await q<DealState>("select status, closed_at, amount_agorot from public.deals where id = $1", [id])).rows[0]);

  const update = (userId: string, id: string, set: string, params: unknown[] = []) =>
    asUser(userId, async (q) => (await q(`update public.deals set ${set} where id = $1 returning id`, [id, ...params])).rowCount);

  const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

  beforeAll(async () => {
    owner = await createUser("close-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "close-member");
    const pipeline = await defaultPipeline(org);
    pipelineId = pipeline.pipelineId;
    openStage = pipeline.stages.find((s) => s.kind === "open")!.id;
    wonStage = pipeline.stages.find((s) => s.kind === "won")!.id;
    lostStage = pipeline.stages.find((s) => s.kind === "lost")!.id;
  });

  it("a member closes their deal as won with the confirmed amount and a past close date", async () => {
    const id = await newDeal(member.id, openStage);
    const day = ago(10);
    expect(await update(member.id, id, "stage_id = $2, amount_agorot = $3, closed_at = $4", [wonStage, 1_250_000, day])).toBe(1);
    const deal = await readDeal(id);
    expect(deal.status).toBe("won");
    expect(Number(deal.amount_agorot)).toBe(1_250_000);
    expect(deal.closed_at?.toISOString()).toBe(day);
  });

  it("a move into won without a date is stamped now, as before", async () => {
    const id = await newDeal(member.id, openStage);
    const before = Date.now();
    await update(member.id, id, "stage_id = $2", [wonStage]);
    const deal = await readDeal(id);
    expect(deal.status).toBe("won");
    expect(deal.closed_at!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
  });

  it("moving between lost and won without a date takes a new date, not the old one", async () => {
    const id = await newDeal(member.id, openStage);
    const lostDay = ago(40);
    await update(member.id, id, "stage_id = $2, closed_at = $3", [lostStage, lostDay]);
    expect((await readDeal(id)).closed_at?.toISOString()).toBe(lostDay);

    const before = Date.now();
    await update(member.id, id, "stage_id = $2", [wonStage]);
    const won = await readDeal(id);
    expect(won.status).toBe("won");
    expect(won.closed_at!.getTime()).toBeGreaterThanOrEqual(before - 5_000);

    // and back to lost, also without a date
    const wonAt = won.closed_at!.getTime();
    await update(member.id, id, "stage_id = $2", [lostStage]);
    expect((await readDeal(id)).closed_at!.getTime()).toBeGreaterThanOrEqual(wonAt);
  });

  it("other edits of a closed deal keep its close date; a move between won stages too", async () => {
    const id = await newDeal(member.id, openStage);
    const day = ago(3);
    await update(member.id, id, "stage_id = $2, closed_at = $3", [wonStage, day]);
    await update(member.id, id, "amount_agorot = 999, name = 'שם חדש'");
    expect((await readDeal(id)).closed_at?.toISOString()).toBe(day);
    // a person may correct the date of a closed deal later
    const corrected = ago(5);
    await update(member.id, id, "closed_at = $2", [corrected]);
    expect((await readDeal(id)).closed_at?.toISOString()).toBe(corrected);
  });

  it("an open deal never keeps a close date, from a person or on reopening", async () => {
    const id = await newDeal(member.id, openStage);
    await update(member.id, id, "closed_at = $2", [ago(1)]);
    expect((await readDeal(id)).closed_at).toBeNull();
    const inserted = await asUser(member.id, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, pipeline_id, stage_id, closed_at) values ($1, 'x', $2, $3, $4) returning id",
          [org, pipelineId, openStage, ago(2)],
        )
      ).rows[0].id,
    );
    expect((await readDeal(inserted)).closed_at).toBeNull();

    await update(member.id, id, "stage_id = $2", [wonStage]);
    await update(member.id, id, "stage_id = $2", [openStage]);
    const reopened = await readDeal(id);
    expect(reopened.status).toBe("open");
    expect(reopened.closed_at).toBeNull();
  });

  it("a person may not close a deal more than a day ahead", async () => {
    const id = await newDeal(member.id, openStage);
    const err = await pgError(update(member.id, id, "stage_id = $2, closed_at = $3", [wonStage, ahead(3)]));
    expect(err.code).toBe("P0001");
    expect(err.hint).toBe("deal:closed_at");
    expect((await readDeal(id)).status).toBe("open");

    // the same on a later edit and on insert
    await update(member.id, id, "stage_id = $2", [wonStage]);
    expect((await pgError(update(member.id, id, "closed_at = $2", [ahead(2)]))).hint).toBe("deal:closed_at");
    const insertErr = await pgError(
      asUser(member.id, (q) =>
        q("insert into public.deals (organization_id, name, pipeline_id, stage_id, closed_at) values ($1, 'x', $2, $3, $4)", [org, pipelineId, wonStage, ahead(5)]),
      ),
    );
    expect(insertErr.hint).toBe("deal:closed_at");

    // a few hours ahead (another time zone's today) is fine
    const soon = new Date(Date.now() + 6 * 3_600_000).toISOString();
    expect(await update(member.id, id, "closed_at = $2", [soon])).toBe(1);
  });

  it("bulk undo of a stage change brings the original close date back with the stage", async () => {
    // what src/features/bulk/actions.ts does: snapshot stage_id + closed_at, move, then one update back
    const id = await newDeal(member.id, openStage);
    const wonDay = ago(20);
    await update(member.id, id, "stage_id = $2, closed_at = $3", [wonStage, wonDay]);
    const before = await asUser(member.id, async (q) =>
      (await q<{ stage_id: string; closed_at: Date | null }>("select stage_id, closed_at from public.deals where id = $1", [id])).rows[0],
    );

    await update(member.id, id, "stage_id = $2", [lostStage]);
    expect((await readDeal(id)).closed_at?.toISOString()).not.toBe(wonDay);

    expect(await update(member.id, id, "stage_id = $2, closed_at = $3", [before.stage_id, before.closed_at])).toBe(1);
    const undone = await readDeal(id);
    expect(undone.status).toBe("won");
    expect(undone.closed_at?.toISOString()).toBe(wonDay);

    // an open deal's snapshot is null: undo of a bulk move into won reopens it without a date
    const open = await newDeal(member.id, openStage);
    await update(member.id, open, "stage_id = $2", [wonStage]);
    expect(await update(member.id, open, "stage_id = $2, closed_at = $3", [openStage, null])).toBe(1);
    expect((await readDeal(open)).closed_at).toBeNull();
  });

  it("server writers are not limited", async () => {
    const id = await newDeal(member.id, openStage);
    const far = ahead(30);
    await asAdmin((q) => q("update public.deals set stage_id = $2, closed_at = $3 where id = $1", [id, wonStage, far]));
    expect((await readDeal(id)).closed_at?.toISOString()).toBe(far);
  });

  it("the onboarding task links to the won deal and its contact, with the user's session", async () => {
    const contact = await asUser(member.id, async (q) =>
      (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'דנה') returning id", [org])).rows[0].id,
    );
    const id = await newDeal(member.id, openStage);
    await update(member.id, id, "contact_id = $2", [contact]);
    await update(member.id, id, "stage_id = $2, closed_at = $3", [wonStage, ago(0)]);
    const task = await asUser(member.id, async (q) =>
      (
        await q<{ id: string; owner_id: string }>(
          "insert into public.tasks (organization_id, title, task_type, priority, deal_id, contact_id, owner_id) values ($1, 'קליטת לקוח: עסקה', 'todo', 2, $2, $3, $4) returning id, owner_id",
          [org, id, contact, owner.id],
        )
      ).rows[0],
    );
    expect(task.owner_id).toBe(owner.id);
  });
});

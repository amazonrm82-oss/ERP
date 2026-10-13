import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STAGE_COLOR_VALUES } from "@/features/deals/stage-colors";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };

// DEAL-01: a stage's colour is a palette key, and its days are 1..365 or empty.
describe("stage settings (DEAL-01)", () => {
  let owner: U;
  let member: U;
  let org: string;
  let stageId: string;

  beforeAll(async () => {
    owner = await createUser("stage-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "stage-member");
    stageId = (await defaultPipeline(org)).stages[0].id;
  });

  const update = (userId: string, color: string | null, rotDays: number | null) =>
    asUser(userId, async (q) =>
      (await q("update public.stages set color = $2, rot_days = $3 where organization_id = $4 and id = $1", [stageId, color, rotDays, org])).rowCount,
    );

  it("both checks are in force and validated", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ conname: string; convalidated: boolean }>(
          `select conname, convalidated from pg_catalog.pg_constraint
            where conrelid = 'public.stages'::regclass and conname in ('stages_color_token', 'stages_rot_days_max')
            order by conname collate "C"`,
        )
      ).rows,
    );
    expect(rows).toEqual([
      { conname: "stages_color_token", convalidated: true },
      { conname: "stages_rot_days_max", convalidated: true },
    ]);
  });

  it("an admin sets every palette colour and the days; empty goes back to the default", async () => {
    for (const color of STAGE_COLOR_VALUES) {
      expect(await update(owner.id, color, 30), color).toBe(1);
    }
    expect(await update(owner.id, null, null)).toBe(1);
    expect(await update(owner.id, "warning", 365)).toBe(1);
    const row = await asAdmin(async (q) => (await q<{ color: string; rot_days: number }>("select color, rot_days from public.stages where id = $1", [stageId])).rows[0]);
    expect(row).toEqual({ color: "warning", rot_days: 365 });
  });

  it("a free colour, a class name or days out of range are refused", async () => {
    for (const color of ["#ff0000", "red", "bg-danger", "Accent", ""]) {
      expect((await pgError(update(owner.id, color, null))).code, color).toBe("23514");
    }
    for (const days of [0, -1, 366, 10000]) {
      expect((await pgError(update(owner.id, null, days))).code, String(days)).toBe("23514");
    }
  });

  it("a member cannot change a stage", async () => {
    expect(await update(member.id, "danger", 3)).toBe(0);
  });

  it("the stuck report uses the stage's days", async () => {
    await update(owner.id, null, 1);
    const dealId = await asUser(owner.id, async (q) => {
      const pipeline = await defaultPipeline(org);
      return (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, pipeline_id, stage_id, name) values ($1, $2, $3, 'עסקה ישנה') returning id",
          [org, pipeline.pipelineId, stageId],
        )
      ).rows[0].id;
    });
    // the last thing that happened with it was a call three days ago
    await asUser(owner.id, (q) =>
      q("insert into public.activities (organization_id, deal_id, type, body, occurred_at) values ($1, $2, 'call', 'שיחה', now() - interval '3 days')", [org, dealId]),
    );
    const idle = async () =>
      asUser(owner.id, async (q) => {
        const report = (await q<{ r: { id: string; idle: boolean }[] }>("select public.report_stuck_deals($1) as r", [org])).rows[0].r;
        return report.find((row) => row.id === dealId)?.idle ?? false;
      });
    expect(await idle()).toBe(true);
    await update(owner.id, null, 10);
    expect(await idle()).toBe(false);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAdmin, asUser, closePool, count, createOrg, createUser, defaultLeadStatus, defaultPipeline } from "./helpers";

afterAll(closePool);

// RVW-6: every run of a scheduled rule started again from the oldest record and
// scanned at most 20,000. Records whose conditions do not match leave no run
// behind, so with more of them than the limit the rule never reached the newer
// records. The limit is lowered here with the setting app.scheduled_scan_limit.
describe("scheduled automations continue where the last run stopped (RVW-6)", () => {
  let owner: { id: string };
  let org: string;
  const LIMIT = 100;

  beforeAll(async () => {
    owner = await createUser("cursor-owner");
    org = await createOrg(owner.id);
    // 350 dormant leads that will not match (created 30 to 379 days ago),
    // then 20 newer dormant leads that will (created 5 to 24 days ago)
    const status = await defaultLeadStatus(org);
    await asAdmin((q) =>
      q(
        `insert into public.leads (organization_id, full_name, owner_id, status_id, created_at, campaign)
         select $1::uuid, 'ישן ' || g, $2::uuid, $3::uuid, now() - make_interval(days => 29 + g), 'חורף' from generate_series(1, 350) g
         union all
         select $1, 'חדש ' || g, $2, $3, now() - make_interval(days => 4 + g), 'קיץ' from generate_series(1, 20) g`,
        [org, owner.id, status],
      ),
    );
  });

  const createRule = (entity: string, trigger: string, config: unknown, conditions: unknown[]) =>
    asUser(owner.id, async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.automations (organization_id, name, entity_type, trigger_type, trigger_config, conditions, actions)
           values ($1, 'סמן', $2, $3, $4, $5, '[{"type": "notify", "to": "owner", "title": "בדיקה: {{name}}"}]') returning id`,
          [org, entity, trigger, JSON.stringify(config), JSON.stringify(conditions)],
        )
      ).rows[0].id,
    );
  const runs = (id: string) => asAdmin((q) => count(q, "select 1 from public.automation_runs where automation_id = $1", [id]));
  const runScheduled = (limit = LIMIT) =>
    asAdmin(async (q) => {
      await q("select set_config('app.scheduled_scan_limit', $1, true)", [String(limit)]);
      await q("select app.run_scheduled_automations()");
    });
  const cursor = (id: string) =>
    asAdmin(async (q) => (await q<{ after_at: string }>("select after_at::text from app.automation_scan_cursors where automation_id = $1", [id])).rows[0]?.after_at);
  const deactivate = (id: string) => asAdmin((q) => q("update public.automations set is_active = false where id = $1", [id]));

  it("the scan limit comes from the setting, at most 20,000", async () => {
    const limit = (value: string | null) =>
      asAdmin(async (q) => {
        if (value !== null) await q("select set_config('app.scheduled_scan_limit', $1, true)", [value]);
        return (await q<{ n: number }>("select app.scheduled_scan_limit() as n")).rows[0].n;
      });
    expect(await limit(null)).toBe(20000);
    expect(await limit("100")).toBe(100);
    expect(await limit("999999")).toBe(20000);
    expect(await limit("0")).toBe(1);
    expect(await limit("abc")).toBe(20000);
  });

  it("matching records behind more non-matching ones than the limit are reached within a few runs", async () => {
    const id = await createRule("lead", "no_activity", { days: 3 }, [{ field: "campaign", op: "eq", value: "קיץ" }]);
    // 370 records, 100 a run: runs 1 to 3 see only non-matching leads
    for (let run = 1; run <= 3; run++) {
      await runScheduled();
      expect(await runs(id)).toBe(0);
      expect(await cursor(id)).not.toBe("-infinity");
    }
    // run 4 reaches the end of the list: the 20 matching leads run, and the cursor goes back to the start
    await runScheduled();
    expect(await runs(id)).toBe(20);
    expect(await cursor(id)).toBe("-infinity");
    // each occasion runs once
    for (let run = 1; run <= 4; run++) await runScheduled();
    expect(await runs(id)).toBe(20);
    await deactivate(id);
  });

  it("an edited rule starts again from the oldest record", async () => {
    const id = await createRule("lead", "no_activity", { days: 3 }, [{ field: "campaign", op: "eq", value: "אביב" }]);
    await runScheduled();
    await runScheduled();
    expect(await cursor(id)).not.toBe("-infinity");
    // the oldest lead now matches; the run after the edit starts from it
    await asAdmin((q) =>
      q("update public.leads set campaign = 'אביב' where id = (select id from public.leads where organization_id = $1 order by created_at limit 1)", [org]),
    );
    await asUser(owner.id, (q) => q("update public.automations set trigger_config = '{\"days\": 4}' where id = $1", [id]));
    await runScheduled();
    expect(await runs(id)).toBe(1);
    await deactivate(id);
  });

  it("stuck deals: the same cursor", async () => {
    const { pipelineId, stages } = await defaultPipeline(org);
    const open = stages.find((s) => s.kind === "open")!.id;
    await asAdmin(async (q) => {
      await q(
        `insert into public.deals (organization_id, name, pipeline_id, stage_id, owner_id)
         select $1, 'עסקה ' || g, $2, $3, $4 from generate_series(1, 250) g`,
        [org, pipelineId, open, owner.id],
      );
      // 230 old ones worth nothing, then 20 newer ones worth 1,000 shekels
      await q(
        `update public.deals d set stage_entered_at = now() - make_interval(days => 20 + n.rn::int),
                amount_agorot = case when n.rn <= 20 then 100000 else 0 end
           from (select id, row_number() over (order by id) as rn from public.deals where organization_id = $1) n
          where d.id = n.id`,
        [org],
      );
    });
    const id = await createRule("deal", "stuck_in_stage", { days: 10 }, [{ field: "amount_agorot", op: "gte", value: "1" }]);
    await runScheduled();
    await runScheduled();
    expect(await runs(id)).toBe(0);
    await runScheduled();
    expect(await runs(id)).toBe(20);
    expect(await cursor(id)).toBe("-infinity");
    await deactivate(id);
  });

  it("the cursors are not reachable by clients", async () => {
    await expect(asUser(owner.id, (q) => q("select * from app.automation_scan_cursors"))).rejects.toThrow(/permission denied/);
    await expect(asUser(owner.id, (q) => q("select app.scan_cursor_set(a, now(), gen_random_uuid()) from public.automations a limit 1"))).rejects.toThrow(
      /permission denied/,
    );
  });
});

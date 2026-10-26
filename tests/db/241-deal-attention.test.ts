import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline } from "./helpers";

afterAll(closePool);

type Row = { id: string; stuck: boolean; postponed: boolean; no_next_step: boolean; days_in_stage: number; limit_days: number; idle_days: number; last_activity_at: string | null };

// DEAL-02 gap: the board and the deal page read public.deal_attention(org, deal ids), which answers
// report_stuck_deals' row for every listed deal that needs attention, with no 200-row cap. Both read
// one rule (app.deal_attention_rows), and both are security invoker.
describe("deal attention for the board", () => {
  let owner: { id: string };
  let member: { id: string };
  let other: { id: string };
  let org: string;
  let otherOrg: string;
  let pipelineId: string;
  let openStage: string;
  let otherDeal: string;
  let ids: string[] = [];

  const attention = (userId: string, dealIds: string[], orgId = org) =>
    asUser(userId, async (q) => (await q<{ r: Row[] }>("select public.deal_attention($1, $2::uuid[]) as r", [orgId, dealIds])).rows[0].r);
  const report = (userId: string) =>
    asUser(userId, async (q) => (await q<{ r: Row[] }>("select public.report_stuck_deals($1) as r", [org])).rows[0].r);

  beforeAll(async () => {
    owner = await createUser("attention-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "attention-member");
    const pipeline = await defaultPipeline(org);
    pipelineId = pipeline.pipelineId;
    openStage = pipeline.stages.find((s) => s.kind === "open")!.id;
    await asAdmin((q) => q("update public.stages set rot_days = null where pipeline_id = $1", [pipelineId]));

    // 260 deals: 230 of the owner and 30 of the member; the server arranges their past
    ids = await asAdmin(async (q) =>
      (
        await q<{ id: string }>(
          `insert into public.deals (organization_id, pipeline_id, stage_id, name, amount_agorot, owner_id)
           select $1, $2, $3, 'עסקה ' || g, g * 100, case when g <= 230 then $4::uuid else $5::uuid end
             from generate_series(1, 260) g
           returning id`,
          [org, pipelineId, openStage, owner.id, member.id],
        )
      ).rows.map((r) => r.id),
    );
    await asAdmin(async (q) => {
      // a mix: stuck (every third), postponed (some stuck ones), with a next step (every fifth), fresh ones
      await q(
        `update public.deals d set stage_entered_at = now() - make_interval(days => case when x.n % 3 = 0 then 40 else 2 end) - interval '1 hour',
                snoozed_until = case when x.n % 9 = 0 then current_date + 30 else null end
           from (select id, row_number() over (order by name) n from public.deals where organization_id = $1) x
          where d.id = x.id`,
        [org],
      );
      await q(
        `insert into public.tasks (organization_id, title, deal_id, owner_id, due_at)
         select d.organization_id, 'צעד הבא', d.id, d.owner_id, now() + interval '2 days'
           from (select id, organization_id, owner_id, row_number() over (order by name) n from public.deals where organization_id = $1) d
          where d.n % 5 = 0`,
        [org],
      );
    });

    other = await createUser("attention-other");
    otherOrg = await createOrg(other.id);
    const otherPipeline = await defaultPipeline(otherOrg);
    otherDeal = await asUser(other.id, async (q) =>
      (
        await q<{ id: string }>("insert into public.deals (organization_id, pipeline_id, stage_id, name) values ($1, $2, $3, 'זרה') returning id", [
          otherOrg,
          otherPipeline.pipelineId,
          otherPipeline.stages.find((s) => s.kind === "open")!.id,
        ])
      ).rows[0].id,
    );
  });

  it("the report stops at 200 rows; deal_attention marks every listed deal", async () => {
    const all = await asAdmin(async (q) =>
      (
        await q<{ n: string }>(
          "select count(*)::text as n from app.deal_attention_rows($1, null, null, 14, null) y where y.stuck or y.no_next_step or y.postponed",
          [org],
        )
      ).rows[0].n,
    );
    expect(Number(all)).toBeGreaterThan(200);
    expect((await report(owner.id)).length).toBe(200);
    expect((await attention(owner.id, ids)).length).toBe(Number(all));
  });

  it("gives the same row as report_stuck_deals for every deal the report returns", async () => {
    const reportRows = await report(owner.id);
    const byId = new Map((await attention(owner.id, ids)).map((r) => [r.id, r]));
    for (const row of reportRows) expect(byId.get(row.id)).toEqual(row);
    // and the same states the report would give past its cap: stuck, postponed and no-next-step all occur
    const rows = [...byId.values()];
    expect(rows.some((r) => r.stuck)).toBe(true);
    expect(rows.some((r) => r.postponed && !r.stuck)).toBe(true);
    expect(rows.some((r) => r.no_next_step && !r.stuck && !r.postponed)).toBe(true);
  });

  it("answers only the listed deals, and none for an empty or missing list", async () => {
    const some = ids.slice(0, 30);
    const rows = await attention(owner.id, some);
    expect(rows.every((r) => some.includes(r.id))).toBe(true);
    expect(await attention(owner.id, [])).toEqual([]);
    expect(await asUser(owner.id, async (q) => (await q<{ r: Row[] }>("select public.deal_attention($1, null) as r", [org])).rows[0].r)).toEqual([]);
  });

  it("leaves out closed deals and deals in the recycle bin", async () => {
    const [closed, binned] = (await attention(owner.id, ids)).slice(0, 2).map((r) => r.id);
    await asAdmin(async (q) => {
      const won = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [pipelineId])).rows[0].id;
      await q("update public.deals set stage_id = $2 where id = $1", [closed, won]);
      await q("update public.deals set deleted_at = now() where id = $1", [binned]);
    });
    const after = (await attention(owner.id, ids)).map((r) => r.id);
    expect(after).not.toContain(closed);
    expect(after).not.toContain(binned);
  });

  it("is security invoker: a member with 'own' visibility sees only their own deals", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const memberDeals = await asAdmin(async (q) =>
        (await q<{ id: string }>("select id from public.deals where organization_id = $1 and owner_id = $2", [org, member.id])).rows.map((r) => r.id),
      );
      const rows = await attention(member.id, ids);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => memberDeals.includes(r.id))).toBe(true);
      // the same set as the member's report (below its cap)
      expect(rows.map((r) => r.id).sort()).toEqual((await report(member.id)).map((r) => r.id).sort());
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("never answers another business's deals", async () => {
    expect(await attention(owner.id, [otherDeal])).toEqual([]);
    expect(await attention(owner.id, [otherDeal], otherOrg)).toEqual([]);
    expect((await attention(other.id, [otherDeal], otherOrg)).map((r) => r.id)).toEqual([otherDeal]);
    expect(await attention(other.id, ids)).toEqual([]);
  });

  it("is invoker and granted to authenticated only", async () => {
    const rows = await asAdmin(async (q) =>
      (
        await q<{ name: string; definer: boolean; anon: boolean; auth: boolean }>(
          `select p.oid::regprocedure::text as name, p.prosecdef as definer,
                  has_function_privilege('anon', p.oid, 'execute') as anon,
                  has_function_privilege('authenticated', p.oid, 'execute') as auth
             from pg_proc p where p.oid in ('public.deal_attention(uuid, uuid[])'::regprocedure,
                                            'app.deal_attention_rows(uuid, uuid, uuid, integer, uuid[])'::regprocedure)`,
        )
      ).rows,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatchObject({ definer: false, anon: false, auth: true });
  });
});

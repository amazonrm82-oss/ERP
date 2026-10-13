import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asUser, closePool, createOrg, createUser, defaultPipeline, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string };
type StuckRow = {
  id: string;
  name: string;
  stuck: boolean;
  no_next_step: boolean;
  days_in_stage: number;
  limit_days: number;
  idle_days: number;
  last_activity_at: string | null;
  snoozed_until: string | null;
  postponed: boolean;
};

const MIGRATION = path.join(process.cwd(), "supabase/migrations/20261006012900_deal_stage_entered.sql");

// Owner's decision, 13 October 2026 (DEAL-01, MNY-01, MNY-05): a deal is stuck by time in its
// stage: days since it entered the stage > the stage's rot_days (null = 14). Postponed deals are
// not stuck before their day; closed deals never are. Every row says when the last activity was,
// and deals without activity come first.
describe("stuck deals by time in stage", () => {
  let owner: U;
  let member: U;
  let org: string;
  let pipelineId: string;
  let openStage: string;
  let secondStage: string;
  let wonStage: string;

  const stageEntered = async (dealId: string) =>
    asAdmin(async (q) => (await q<{ at: Date }>("select stage_entered_at as at from public.deals where id = $1", [dealId])).rows[0].at);

  const newDeal = (userId: string, name: string, stageId = openStage) =>
    asUser(userId, async (q) =>
      (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, pipeline_id, stage_id, name, amount_agorot) values ($1, $2, $3, $4, 1000) returning id",
          [org, pipelineId, stageId, name],
        )
      ).rows[0].id,
    );

  // the server arranges the past: the deal entered its stage `days` days ago
  const enteredDaysAgo = (dealId: string, days: number) =>
    asAdmin((q) => q("update public.deals set stage_entered_at = now() - make_interval(days => $2) - interval '1 hour' where id = $1", [dealId, days]));

  const report = async (userId: string, args = "$1") =>
    asUser(userId, async (q) => (await q<{ r: StuckRow[] }>(`select public.report_stuck_deals(${args}) as r`, [org])).rows[0].r);

  const rowOf = async (dealId: string) => (await report(owner.id)).find((row) => row.id === dealId);

  // today in the organization's time zone, "YYYY-MM-DD"
  const orgToday = () =>
    asAdmin(async (q) =>
      (await q<{ d: string }>("select to_char((now() at time zone o.timezone)::date, 'YYYY-MM-DD') as d from public.organizations o where o.id = $1", [org])).rows[0].d,
    );
  const snoozeOf = (dealId: string) =>
    asAdmin(async (q) => (await q<{ s: string | null }>("select to_char(snoozed_until, 'YYYY-MM-DD') as s from public.deals where id = $1", [dealId])).rows[0].s);
  const systemEntries = (dealId: string) =>
    asAdmin(async (q) =>
      (
        await q<{ body: string; created_by: string | null; kind: string }>(
          "select body, created_by, metadata ->> 'kind' as kind from public.activities where deal_id = $1 and type = 'system' order by created_at",
          [dealId],
        )
      ).rows,
    );

  beforeAll(async () => {
    owner = await createUser("stuck-owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "stuck-member");
    const pipeline = await defaultPipeline(org);
    pipelineId = pipeline.pipelineId;
    const open = pipeline.stages.filter((s) => s.kind === "open");
    openStage = open[0].id;
    secondStage = open[1].id;
    wonStage = pipeline.stages.find((s) => s.kind === "won")!.id;
    // the default of 14 days on the stages under test
    await asAdmin((q) => q("update public.stages set rot_days = null where pipeline_id = $1", [pipelineId]));
  });

  describe("stage_entered_at", () => {
    it("is set on insert, even when a person sends another value", async () => {
      const id = await asUser(owner.id, async (q) =>
        (
          await q<{ id: string }>(
            `insert into public.deals (organization_id, pipeline_id, stage_id, name, stage_entered_at)
             values ($1, $2, $3, 'הכנסה', now() - interval '90 days') returning id`,
            [org, pipelineId, openStage],
          )
        ).rows[0].id,
      );
      expect(Date.now() - (await stageEntered(id)).getTime()).toBeLessThan(60_000);
    });

    it("moves with a change of stage, for every writer", async () => {
      const id = await newDeal(owner.id, "מעבר שלב");
      await enteredDaysAgo(id, 30);
      await asUser(owner.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [id, secondStage]));
      expect(Date.now() - (await stageEntered(id)).getTime()).toBeLessThan(60_000);

      await enteredDaysAgo(id, 30);
      await asAdmin((q) => q("update public.deals set stage_id = $2 where id = $1", [id, openStage]));
      expect(Date.now() - (await stageEntered(id)).getTime()).toBeLessThan(60_000);
    });

    it("stays when anything else changes, and a person cannot write it", async () => {
      const id = await newDeal(owner.id, "שינוי אחר");
      await enteredDaysAgo(id, 30);
      const before = await stageEntered(id);
      await asUser(owner.id, (q) => q("update public.deals set name = 'שם חדש', amount_agorot = 5000 where id = $1", [id]));
      expect((await stageEntered(id)).getTime()).toBe(before.getTime());

      // straight through the API: an old date (makes it stuck) and a new one (hides it)
      for (const value of ["now() - interval '200 days'", "now()"]) {
        const n = await asUser(owner.id, async (q) => (await q(`update public.deals set stage_entered_at = ${value} where id = $1 returning id`, [id])).rowCount);
        expect(n).toBe(1);
        expect((await stageEntered(id)).getTime()).toBe(before.getTime());
      }
    });
  });

  describe("snoozed_until", () => {
    it("whoever may edit the deal writes it; others cannot", async () => {
      const id = await newDeal(owner.id, "דחייה");
      const set = (userId: string, day: string | null) =>
        asUser(userId, async (q) => (await q("update public.deals set snoozed_until = $2 where id = $1 returning id", [id, day])).rowCount);
      const today = await orgToday();
      const plus = (n: number) => asAdmin(async (q) => (await q<{ d: string }>("select to_char($1::date + $2::int, 'YYYY-MM-DD') as d", [today, n])).rows[0].d);
      expect(await set(owner.id, await plus(10))).toBe(1);
      expect(await set(member.id, await plus(11))).toBe(0);
      expect(await snoozeOf(id)).toBe(await plus(10));
      expect(await set(owner.id, null)).toBe(1);
    });

    it("a person postpones only to a day after today, at most 366 days ahead", async () => {
      const id = await newDeal(owner.id, "גבולות דחייה");
      const today = await orgToday();
      const set = (expr: string) => asUser(owner.id, (q) => q(`update public.deals set snoozed_until = ${expr} where id = $1`, [id]));
      for (const bad of [`'${today}'::date`, `'${today}'::date - 1`, `'${today}'::date + 367`, "'9999-12-31'::date"]) {
        expect(await pgError(set(bad)), bad).toMatchObject({ code: "P0001", hint: "deal:snoozed_until" });
      }
      // also on insert
      const insert = await pgError(
        asUser(owner.id, (q) =>
          q("insert into public.deals (organization_id, pipeline_id, stage_id, name, snoozed_until) values ($1, $2, $3, 'x', '9999-12-31')", [org, pipelineId, openStage]),
        ),
      );
      expect(insert).toMatchObject({ code: "P0001", hint: "deal:snoozed_until" });
      await set(`'${today}'::date + 1`);
      await set(`'${today}'::date + 366`);
      // a closed deal cannot be postponed by a person
      const won = await newDeal(owner.id, "סגורה לא נדחית", wonStage);
      const closed = await pgError(asUser(owner.id, (q) => q(`update public.deals set snoozed_until = '${today}'::date + 5 where id = $1`, [won])));
      expect(closed).toMatchObject({ code: "P0001", hint: "deal:snoozed_until" });
      // a server writer is not limited
      await asAdmin((q) => q("update public.deals set snoozed_until = '2000-01-01' where id = $1", [id]));
      expect(await snoozeOf(id)).toBe("2000-01-01");
    });

    it("a move to another stage cancels it and logs one line, with no notification", async () => {
      const today = await orgToday();
      const notes = () => asAdmin(async (q) => (await q<{ n: number }>("select count(*)::int as n from public.notifications where user_id = $1", [member.id])).rows[0].n);
      // two deals the member follows; the same move, one postponed and one not
      const plain = await newDeal(owner.id, "מעבר בלי דחייה");
      const id = await newDeal(owner.id, "דחייה ומעבר");
      for (const deal of [plain, id]) {
        await asUser(member.id, (q) => q("insert into public.record_followers (organization_id, deal_id) values ($1, $2)", [org, deal]));
      }
      await asUser(owner.id, (q) => q(`update public.deals set snoozed_until = '${today}'::date + 5 where id = $1`, [id]));

      // other changes keep it
      await asUser(owner.id, (q) => q("update public.deals set amount_agorot = 9000, name = 'דחייה ומעבר 2' where id = $1", [id]));
      await asUser(owner.id, (q) => q("insert into public.activities (organization_id, deal_id, type, body) values ($1, $2, 'note', 'הערה')", [org, id]));
      expect(await snoozeOf(id)).not.toBeNull();
      expect(await systemEntries(id)).toEqual([]);

      const n0 = await notes();
      await asUser(owner.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [plain, secondStage]));
      const n1 = await notes();
      await asUser(owner.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [id, secondStage]));
      const n2 = await notes();
      // the cancellation adds nothing to what a move notifies anyway
      expect(n2 - n1).toBe(n1 - n0);

      expect(await snoozeOf(id)).toBeNull();
      const stageName = await asAdmin(async (q) => (await q<{ name: string }>("select name from public.stages where id = $1", [secondStage])).rows[0].name);
      // the mover, as on the stage_change entry of the same move
      expect(await systemEntries(id)).toEqual([{ body: `הדחייה בוטלה כי העסקה עברה לשלב ${stageName}`, created_by: owner.id, kind: "snooze_cleared" }]);
      expect(await systemEntries(plain)).toEqual([]);
      // not the last activity: that is the stage_change entry of the move, not later
      const last = (await rowOf(id))?.last_activity_at;
      const stageChange = await asAdmin(async (q) =>
        (await q<{ at: Date }>("select max(occurred_at) as at from public.activities where deal_id = $1 and type in ('stage_change', 'note')", [id])).rows[0].at,
      );
      // to the millisecond (the JSON keeps microseconds)
      expect(last && Math.floor(Date.parse(last))).toBe(stageChange.getTime());
    });

    it("the line is not contact and not the last activity", async () => {
      const id = await newDeal(owner.id, "לא פעילות");
      const today = await orgToday();
      await asUser(owner.id, (q) => q(`update public.deals set snoozed_until = '${today}'::date + 5 where id = $1`, [id]));
      await asAdmin((q) => q("update public.deals set stage_id = $2 where id = $1", [id, secondStage]));
      expect(await systemEntries(id)).toMatchObject([{ created_by: null }]);
      const row = await rowOf(id);
      expect(row).toMatchObject({ no_next_step: true, last_activity_at: null });
      const contact = await asAdmin(async (q) => (await q<{ ok: boolean }>("select 'system' = any (app.contact_types()) as ok")).rows[0].ok);
      expect(contact).toBe(false);
    });

    it("reopening a closed deal cancels it; an expired one is cleared without a line", async () => {
      const id = await newDeal(owner.id, "נפתחה מחדש", wonStage);
      const today = await orgToday();
      await asAdmin((q) => q(`update public.deals set snoozed_until = '${today}'::date + 3 where id = $1`, [id]));
      await asUser(owner.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [id, openStage]));
      expect(await snoozeOf(id)).toBeNull();
      expect(await systemEntries(id)).toHaveLength(1);

      await asAdmin((q) => q(`update public.deals set snoozed_until = '${today}'::date - 2 where id = $1`, [id]));
      await asUser(owner.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [id, secondStage]));
      expect(await snoozeOf(id)).toBeNull();
      expect(await systemEntries(id)).toHaveLength(1);
    });

    it("has a column grant, so it stays writable under column grants", async () => {
      const rows = await asAdmin(async (q) =>
        (
          await q<{ privilege_type: string }>(
            `select privilege_type from information_schema.column_privileges
              where table_schema = 'public' and table_name = 'deals' and column_name = 'snoozed_until' and grantee = 'authenticated'
              order by 1`,
          )
        ).rows.map((r) => r.privilege_type),
      );
      expect(rows).toEqual(expect.arrayContaining(["INSERT", "UPDATE"]));
    });
  });

  describe("report_stuck_deals", () => {
    it("stuck only past the stage's days; rot_days null is 14", async () => {
      const id = await newDeal(owner.id, "ימים בשלב");
      // a task, so no_next_step does not bring the row in by itself
      await asUser(owner.id, (q) => q("insert into public.tasks (organization_id, title, deal_id) values ($1, 'לחזור', $2)", [org, id]));

      await enteredDaysAgo(id, 14);
      expect(await rowOf(id)).toBeUndefined();
      await enteredDaysAgo(id, 15);
      expect(await rowOf(id)).toMatchObject({ stuck: true, no_next_step: false, days_in_stage: 15, limit_days: 14 });

      await asAdmin((q) => q("update public.stages set rot_days = 20 where id = $1", [openStage]));
      try {
        expect(await rowOf(id)).toBeUndefined();
        await enteredDaysAgo(id, 21);
        expect(await rowOf(id)).toMatchObject({ stuck: true, limit_days: 20 });
      } finally {
        await asAdmin((q) => q("update public.stages set rot_days = null where id = $1", [openStage]));
      }
    });

    it("recent activity does not unstick it, and an old one does not make it stuck", async () => {
      const busy = await newDeal(owner.id, "פעילה אבל תקועה");
      await enteredDaysAgo(busy, 30);
      await asUser(owner.id, (q) => q("insert into public.activities (organization_id, deal_id, type, body) values ($1, $2, 'call', 'שיחה')", [org, busy]));
      expect(await rowOf(busy)).toMatchObject({ stuck: true, idle_days: 0 });
      expect((await rowOf(busy))?.last_activity_at).toBeTruthy();

      const fresh = await newDeal(owner.id, "חדשה בשלב");
      await asUser(owner.id, (q) =>
        q("insert into public.activities (organization_id, deal_id, type, body, occurred_at) values ($1, $2, 'call', 'שיחה', now() - interval '60 days')", [org, fresh]),
      );
      // in the list for no next step only
      expect(await rowOf(fresh)).toMatchObject({ stuck: false, no_next_step: true, idle_days: 60 });
    });

    it("a postponed deal is not stuck before its day (organization time zone), and is listed as postponed", async () => {
      const id = await newDeal(owner.id, "נדחתה");
      await asUser(owner.id, (q) => q("insert into public.tasks (organization_id, title, deal_id) values ($1, 'לחזור', $2)", [org, id]));
      await enteredDaysAgo(id, 40);
      const today = await orgToday();
      // the day itself and past days are set by the server here (a person may not)
      const snooze = (expr: string) => asAdmin((q) => q(`update public.deals set snoozed_until = ${expr} where id = $1`, [id]));

      await snooze(`'${today}'::date + 1`);
      expect(await rowOf(id)).toMatchObject({ stuck: false, postponed: true, no_next_step: false });
      await snooze(`'${today}'::date`);
      expect(await rowOf(id)).toMatchObject({ stuck: true, postponed: false });
      await snooze(`'${today}'::date - 3`);
      expect(await rowOf(id)).toMatchObject({ stuck: true });
      await snooze("null");
      expect(await rowOf(id)).toMatchObject({ stuck: true });

      // postponed but not past its days: not in the list
      await enteredDaysAgo(id, 2);
      await snooze(`'${today}'::date + 1`);
      expect(await rowOf(id)).toBeUndefined();
    });

    it("closed deals are never in the list", async () => {
      const id = await newDeal(owner.id, "נסגרה", wonStage);
      await enteredDaysAgo(id, 400);
      expect(await rowOf(id)).toBeUndefined();
    });

    it("puts stuck deals first, then deals without activity first within each group", async () => {
      const rows = await report(owner.id);
      const groups = rows.map((r) => (r.stuck ? 0 : 1));
      expect([...groups].sort()).toEqual(groups);
      for (const g of [0, 1]) {
        const keys = rows.filter((r) => (r.stuck ? 0 : 1) === g).map((r) => (r.last_activity_at ? Date.parse(r.last_activity_at) : -Infinity));
        expect([...keys].sort((a, b) => a - b)).toEqual(keys);
      }
      expect(rows.some((r) => r.stuck) && rows.some((r) => !r.stuck)).toBe(true);
    });

    it("the 200-row limit never pushes a stuck deal out", async () => {
      const other = await createOrg(owner.id, "עסק עמוס");
      const p = await defaultPipeline(other);
      const stage = p.stages.find((s) => s.kind === "open")!.id;
      const stuckId = await asAdmin(async (q) => {
        // 210 deals without a next step and without activity: they sort before any deal with activity
        await q(
          "insert into public.deals (organization_id, pipeline_id, stage_id, name) select $1, $2, $3, 'בלי צעד ' || g from generate_series(1, 210) g",
          [other, p.pipelineId, stage],
        );
        const id = (
          await q<{ id: string }>("insert into public.deals (organization_id, pipeline_id, stage_id, name) values ($1, $2, $3, 'תקועה') returning id", [
            other,
            p.pipelineId,
            stage,
          ])
        ).rows[0].id;
        await q("insert into public.tasks (organization_id, title, deal_id) values ($1, 'לחזור', $2)", [other, id]);
        await q("insert into public.activities (organization_id, deal_id, type, body, created_by) values ($1, $2, 'call', 'שיחה', $3)", [other, id, owner.id]);
        await q("update public.deals set stage_entered_at = now() - interval '30 days' where id = $1", [id]);
        return id;
      });
      const rows = await asUser(owner.id, async (q) => (await q<{ r: StuckRow[] }>("select public.report_stuck_deals($1) as r", [other])).rows[0].r);
      expect(rows).toHaveLength(200);
      expect(rows[0]).toMatchObject({ id: stuckId, stuck: true });
    });

    it("counts only deals the caller may see", async () => {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
      try {
        const rows = await report(member.id);
        expect(rows).toEqual([]);
      } finally {
        await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
      }
    });
  });

  describe("stage-entry fill", () => {
    it("no deal can lack a stage-entry date, so the fill has nothing to do", async () => {
      const nullable = await asAdmin(async (q) =>
        (
          await q<{ is_nullable: string }>(
            "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'deals' and column_name = 'stage_entered_at'",
          )
        ).rows[0].is_nullable,
      );
      expect(nullable).toBe("NO");
    });

    it("the migration runs twice without changing a deal, and reports the count", async () => {
      const snapshot = () =>
        asAdmin(async (q) => (await q<{ s: string }>("select md5(string_agg(id::text || stage_entered_at::text || updated_at::text, ',' order by id)) as s from public.deals")).rows[0].s);
      const before = await snapshot();
      const missing = await asAdmin(async (q) => {
        await q(readFileSync(MIGRATION, "utf8"));
        return (await q<{ n: string }>("select count(*)::text as n from public.deals where stage_entered_at is null")).rows[0].n;
      });
      expect(missing).toBe("0");
      expect(await snapshot()).toBe(before);
    });
  });
});

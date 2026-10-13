import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addMember, asAdmin, asAnon, asUser, closePool, createOrg, createUser, pgError } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };
type Row = {
  id: string;
  name: string;
  owner_id: string | null;
  stage_id: string;
  stuck: boolean;
  overdue: boolean;
  days_in_stage: number;
  limit_days: number;
  last_activity_at: string | null;
  expected_close_date: string | null;
};
type Cleanup = { today: string; stuck: { deals: number; amount: number }; overdue: { deals: number; amount: number }; deals: Row[] };

// MNY-05: the weekly pipeline cleanup. Open deals that are stuck by time in stage (the one definition,
// as report_stuck_deals) or past their expected close date (owner, 13 October 2026), each once;
// postponed deals are left out until their day. Security invoker: RLS decides.
describe("weekly pipeline cleanup (MNY-05)", () => {
  let owner: U, m1: U, m2: U, outsider: U;
  let org: string;
  let pipeline: string;
  let firstOpen: string;
  let secondOpen: string;
  const deals: Record<string, string> = {};

  const cleanup = (userId: string, args: unknown[] = []) =>
    asUser(userId, async (q) => {
      const params = [org, ...args];
      return (await q<{ r: Cleanup }>(`select public.report_pipeline_cleanup(${params.map((_, i) => `$${i + 1}`).join(", ")}) as r`, params)).rows[0].r;
    });

  beforeAll(async () => {
    owner = await createUser("owner");
    outsider = await createUser("outsider");
    org = await createOrg(owner.id);
    await createOrg(outsider.id, "עסק אחר");
    m1 = await addMember(org, owner.id, "member", "m1");
    m2 = await addMember(org, owner.id, "member", "m2");

    await asAdmin(async (q) => {
      pipeline = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const open = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position", [pipeline])).rows;
      firstOpen = open[0].id;
      secondOpen = open[1].id;
      // the second stage allows 5 days; the first has no setting (14 by default)
      await q("update public.stages set rot_days = 5 where id = $1", [secondOpen]);
      await q("update public.stages set rot_days = null where id = $1", [firstOpen]);
      const won = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'won' limit 1", [pipeline])).rows[0].id;
      const add = async (key: string, ownerId: string, amount: number, stage: string, daysInStage: number, closeOffset: number | null, snoozeOffset: number | null = null) => {
        deals[key] = (
          await q<{ id: string }>(
            `insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id, expected_close_date)
             values ($1, $2, $3, $4, $5, $6, case when $7::int is null then null else (now() at time zone 'Asia/Jerusalem')::date + $7::int end) returning id`,
            [org, key, ownerId, amount, pipeline, stage, closeOffset],
          )
        ).rows[0].id;
        await q(
          `update public.deals set stage_entered_at = now() - make_interval(days => $2::int) - interval '1 hour',
                  snoozed_until = case when $3::int is null then null else (now() at time zone 'Asia/Jerusalem')::date + $3::int end
            where id = $1`,
          [deals[key], daysInStage, snoozeOffset],
        );
      };
      await add("stuck default", m1.id, 10000, firstOpen, 20, null);
      await add("not stuck yet", m1.id, 11000, firstOpen, 10, null);
      await add("stuck short stage", m2.id, 12000, secondOpen, 6, 30);
      await add("overdue only", m2.id, 13000, firstOpen, 1, -3);
      await add("stuck and overdue", m1.id, 14000, firstOpen, 30, -10);
      await add("postponed", m1.id, 15000, firstOpen, 40, -5, 3);
      await add("postponed until today", m2.id, 16000, firstOpen, 40, null, 0);
      await add("won long ago", m1.id, 17000, won, 90, -60);
      await add("in the bin", m1.id, 18000, firstOpen, 90, -60);
      await q("update public.deals set deleted_at = now() where id = $1", [deals["in the bin"]]);
      // a person's call on "stuck default": it has activity, the rest have none
      await q("insert into public.activities (organization_id, type, deal_id, body, created_by, occurred_at) values ($1, 'call', $2, 'שיחה', $3, now() - interval '2 days')", [
        org,
        deals["stuck default"],
        m1.id,
      ]);
    });
  });

  it("lists stuck and overdue deals once each, with why; postponed, closed and binned deals are left out", async () => {
    const c = await cleanup(owner.id);
    const byName = new Map(c.deals.map((d) => [d.name, d]));
    expect([...byName.keys()].sort()).toEqual(["overdue only", "postponed until today", "stuck and overdue", "stuck default", "stuck short stage"].sort());
    expect(byName.get("stuck default")).toMatchObject({ stuck: true, overdue: false, limit_days: 14 });
    expect(byName.get("stuck short stage")).toMatchObject({ stuck: true, overdue: false, limit_days: 5 });
    expect(byName.get("overdue only")).toMatchObject({ stuck: false, overdue: true });
    expect(byName.get("stuck and overdue")).toMatchObject({ stuck: true, overdue: true });
    // a postponement until today is over: the deal is stuck again (as in report_stuck_deals)
    expect(byName.get("postponed until today")).toMatchObject({ stuck: true });
    // each deal once in the totals: overdue counts only what is not stuck
    expect(c.stuck).toEqual({ deals: 4, amount: 10000 + 12000 + 14000 + 16000 });
    expect(c.overdue).toEqual({ deals: 1, amount: 13000 });
  });

  it("stuck is exactly report_stuck_deals' stuck", async () => {
    const [c, report] = await Promise.all([
      cleanup(owner.id),
      asUser(owner.id, async (q) => (await q<{ r: { id: string; stuck: boolean }[] }>("select public.report_stuck_deals($1) as r", [org])).rows[0].r),
    ]);
    expect(c.deals.filter((d) => d.stuck).map((d) => d.id).sort()).toEqual(report.filter((d) => d.stuck).map((d) => d.id).sort());
  });

  it("deals without activity come first", async () => {
    const c = await cleanup(owner.id);
    expect(c.deals[c.deals.length - 1].name).toBe("stuck default");
    expect(c.deals.slice(0, -1).every((d) => d.last_activity_at === null)).toBe(true);
  });

  it("advancing, postponing or closing takes a deal off the list", async () => {
    // advance: a move to another stage starts the stage clock again
    await asUser(m1.id, (q) => q("update public.deals set stage_id = $2 where id = $1", [deals["stuck default"], secondOpen]));
    // postpone with a date (the DEAL-01 rule: a day after today)
    await asUser(m2.id, (q) => q("update public.deals set snoozed_until = (now() at time zone 'Asia/Jerusalem')::date + 7 where id = $1", [deals["overdue only"]]));
    // close as lost with a reason
    await asUser(m1.id, async (q) => {
      const reason = (await q<{ id: string }>("select id from public.deal_loss_reasons where organization_id = $1 order by position limit 1", [org])).rows[0].id;
      await q(
        "update public.deals d set stage_id = s.id, lost_reason_id = $2 from public.stages s where d.id = $1 and s.pipeline_id = d.pipeline_id and s.kind = 'lost'",
        [deals["stuck and overdue"], reason],
      );
    });
    const names = (await cleanup(owner.id)).deals.map((d) => d.name).sort();
    expect(names).toEqual(["postponed until today", "stuck short stage"]);
  });

  it("with an owner, that person's deals only", async () => {
    const c = await cleanup(owner.id, [m2.id]);
    expect(c.deals.every((d) => d.owner_id === m2.id)).toBe(true);
    expect(c.deals.length).toBeGreaterThan(0);
  });

  it("RLS decides: under 'own' visibility a member sees their own deals only", async () => {
    await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'own' where id = $1", [org]));
    try {
      const c = await cleanup(m2.id);
      expect(c.deals.length).toBeGreaterThan(0);
      expect(c.deals.every((d) => d.owner_id === m2.id)).toBe(true);
    } finally {
      await asUser(owner.id, (q) => q("update public.organizations set record_visibility = 'org' where id = $1", [org]));
    }
  });

  it("another business gets nothing, and anon may not call it", async () => {
    expect(await asUser(outsider.id, async (q) => (await q<{ r: unknown }>("select public.report_pipeline_cleanup($1) as r", [org])).rows[0].r)).toBeNull();
    expect((await pgError(asAnon((q) => q("select public.report_pipeline_cleanup($1)", [org])))).code).toBe("42501");
  });
});

// Review finding L6: "today" is the organization's own date. Two businesses whose clocks are 25 hours
// apart (Kiritimati UTC+14, Pago Pago UTC-11) never share a date, so the same deals must come out
// differently in each, whatever the time the test runs; a report that used Jerusalem's date (or the
// server's) would treat them alike.
describe("pipeline cleanup in the organization's time zone (MNY-05)", () => {
  type Zone = { tz: string; owner: U; org: string; stuckId: string; overdueId: string };
  const zones: Zone[] = [];
  let pagoToday: string;
  let kiriToday: string;

  beforeAll(async () => {
    const dates = await asAdmin(async (q) =>
      (
        await q<{ p: string; k: string }>(
          "select to_char((now() at time zone 'Pacific/Pago_Pago')::date, 'YYYY-MM-DD') as p, to_char((now() at time zone 'Pacific/Kiritimati')::date, 'YYYY-MM-DD') as k",
        )
      ).rows[0],
    );
    pagoToday = dates.p;
    kiriToday = dates.k;
    for (const tz of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      const owner = await createUser(`tz-${tz.slice(8, 12)}`);
      const org = await createOrg(owner.id, `עסק ${tz}`);
      const ids = await asAdmin(async (q) => {
        await q("update public.organizations set timezone = $2 where id = $1", [org, tz]);
        const pipeline = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
        const stage = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [pipeline])).rows[0].id;
        await q("update public.stages set rot_days = null where id = $1", [stage]);
        const add = async (name: string, expected: string | null, snoozed: string | null, daysInStage: number) => {
          const id = (
            await q<{ id: string }>(
              "insert into public.deals (organization_id, name, owner_id, amount_agorot, pipeline_id, stage_id, expected_close_date) values ($1, $2, $3, 1000, $4, $5, $6) returning id",
              [org, name, owner.id, pipeline, stage, expected],
            )
          ).rows[0].id;
          await q("update public.deals set stage_entered_at = now() - make_interval(days => $2::int) - interval '1 hour', snoozed_until = $3 where id = $1", [id, daysInStage, snoozed]);
          return id;
        };
        // stuck by time, postponed until Kiritimati's today: over in Kiritimati, still on in Pago Pago
        const stuckId = await add("stuck", null, kiriToday, 30);
        // expected on Pago Pago's today: overdue in Kiritimati (a day or two later there), not in Pago Pago
        const overdueId = await add("due", pagoToday, null, 1);
        return { stuckId, overdueId };
      });
      zones.push({ tz, owner, org, ...ids });
    }
  });

  it("stuck and overdue follow each business's own date, in the cleanup, the money screen and the stuck report", async () => {
    expect(kiriToday > pagoToday).toBe(true);
    for (const zone of zones) {
      const inKiritimati = zone.tz === "Pacific/Kiritimati";
      const [cleanupResult, money, stuck] = await asUser(zone.owner.id, async (q) => [
        (await q<{ r: Cleanup }>("select public.report_pipeline_cleanup($1) as r", [zone.org])).rows[0].r,
        (await q<{ r: Cleanup }>("select public.report_money_waiting($1) as r", [zone.org])).rows[0].r,
        (await q<{ r: { id: string; stuck: boolean; postponed: boolean }[] }>("select public.report_stuck_deals($1) as r", [zone.org])).rows[0].r,
      ] as const);
      expect(cleanupResult.today).toBe(inKiritimati ? kiriToday : pagoToday);
      const row = (id: string) => cleanupResult.deals.find((d) => d.id === id);
      if (inKiritimati) {
        expect(row(zone.stuckId)).toMatchObject({ stuck: true });
        expect(row(zone.overdueId)).toMatchObject({ overdue: true, stuck: false });
        expect(cleanupResult.stuck.deals).toBe(1);
        expect(cleanupResult.overdue.deals).toBe(1);
      } else {
        expect(row(zone.stuckId)).toBeUndefined();
        expect(row(zone.overdueId)).toBeUndefined();
        expect(cleanupResult.stuck.deals).toBe(0);
        expect(cleanupResult.overdue.deals).toBe(0);
      }
      // the money screen counts the same deals
      expect(money.stuck).toEqual(cleanupResult.stuck);
      expect(money.overdue).toEqual(cleanupResult.overdue);
      // and the stuck report agrees on the postponement
      expect(stuck.find((d) => d.id === zone.stuckId)).toMatchObject(inKiritimati ? { stuck: true } : { stuck: false, postponed: true });
    }
  });
});

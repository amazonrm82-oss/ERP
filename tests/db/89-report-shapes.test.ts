import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { REPORT_FUNCTIONS, type ReportFunction, keyPaths, parseReportData } from "../../src/features/reports/schemas";
import { addMember, asAdmin, asUser, closePool, createOrg, createUser, insertLead } from "./helpers";

afterAll(closePool);

type U = { id: string; email: string };

// FXC-12: every report_* function is run on a data set that fills every list it returns. Its result
// must pass the app's schema (src/features/reports/schemas.ts) and have exactly the keys of the saved
// sample in tests/unit/fixtures/reports/, which the unit tests shape. A SQL change that renames, drops
// or adds a key fails here until the schema and the sample are updated together.
// UPDATE_REPORT_FIXTURES=1 npm run test:db rewrites the samples from this run.
const FIXTURES = path.resolve(__dirname, "../unit/fixtures/reports");

describe("report result shapes (FXC-12)", () => {
  let owner: U;
  let member: U;
  let org: string;
  const from = () => new Date(Date.now() - 86_400_000).toISOString();
  const to = () => new Date(Date.now() + 86_400_000).toISOString();
  const results = new Map<ReportFunction, unknown>();

  beforeAll(async () => {
    owner = await createUser("owner");
    org = await createOrg(owner.id);
    member = await addMember(org, owner.id, "member", "rep");

    const sourceId = await asAdmin(async (q) =>
      (await q<{ id: string }>("select id from public.lead_sources where organization_id = $1 order by name limit 1", [org])).rows[0].id,
    );
    const lead1 = await insertLead(owner.id, org, { source_id: sourceId, campaign: "חורף" });
    await insertLead(owner.id, org, { source_id: sourceId, campaign: "חורף" });
    const lead3 = await insertLead(member.id, org, { owner_id: member.id });
    await asUser(member.id, (q) =>
      q("insert into public.activities (organization_id, type, body, lead_id) values ($1, 'call', 'שיחה ראשונה', $2)", [org, lead3]),
    );

    // a won deal that went through a second open stage first (cycle length per stage)
    const wonDeal = await asUser(owner.id, async (q) =>
      (await q<{ r: { deal_id: string } }>("select public.convert_lead($1, true, null, 100000) as r", [lead1])).rows[0].r.deal_id,
    );
    // RPT-01: a product line and a free monthly line on the won deal (report_revenue_by_product)
    await asUser(owner.id, async (q) => {
      const product = (
        await q<{ id: string }>("insert into public.products (organization_id, name, price_agorot, vat_kind, price_includes_vat) values ($1, 'ייעוץ', 30000, 'taxable', false) returning id", [org])
      ).rows[0].id;
      await q(
        "insert into public.deal_lines (organization_id, deal_id, product_id, description, quantity, unit_price_agorot, price_source) values ($1, $2, $3, 'ייעוץ', 2, 30000, 'product')",
        [org, wonDeal, product],
      );
      await q("insert into public.deal_lines (organization_id, deal_id, description, quantity, unit_price_agorot, billing) values ($1, $2, 'תחזוקה', 1, 5000, 'monthly')", [org, wonDeal]);
    });
    await asUser(owner.id, async (q) => {
      await q(
        `update public.deals d set stage_id = s.id from public.stages s
          where d.id = $1 and s.pipeline_id = d.pipeline_id and s.kind = 'open'
            and s.position = (select min(position) from public.stages x where x.pipeline_id = d.pipeline_id and x.kind = 'open' and x.position > (select position from public.stages y where y.id = d.stage_id))`,
        [wonDeal],
      );
      await q(
        `update public.deals d set stage_id = s.id from public.stages s
          where d.id = $1 and s.pipeline_id = d.pipeline_id and s.kind = 'won'`,
        [wonDeal],
      );
    });

    // a lost deal with a reason from the list and a competitor
    await asUser(member.id, async (q) => {
      const pipeline = (await q<{ id: string }>("select id from public.pipelines where organization_id = $1 and is_default", [org])).rows[0].id;
      const first = (await q<{ id: string }>("select id from public.stages where pipeline_id = $1 and kind = 'open' order by position limit 1", [pipeline])).rows[0].id;
      const reason = (await q<{ id: string }>("select id from public.deal_loss_reasons where organization_id = $1 order by position limit 1", [org])).rows[0].id;
      const id = (
        await q<{ id: string }>(
          "insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id) values ($1, 'עסקה שאבדה', 50000, $2, $3, $4) returning id",
          [org, pipeline, first, member.id],
        )
      ).rows[0].id;
      await q(
        `update public.deals d set stage_id = s.id, lost_reason_id = $2, competitor = 'מתחרה' from public.stages s
          where d.id = $1 and s.pipeline_id = d.pipeline_id and s.kind = 'lost'`,
        [id, reason],
      );
    });

    // a deal created straight in a lost stage: no stage-move history, so report_lost_reasons
    // has a by_stage row with no stage (stage_id, name and position null)
    await asUser(owner.id, (q) =>
      q(
        `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id)
         select $1, 'אבדה מיד', 20000, p.id, s.id, $2
           from public.pipelines p join public.stages s on s.pipeline_id = p.id and s.kind = 'lost'
          where p.organization_id = $1 and p.is_default limit 1`,
        [org, owner.id],
      ),
    );

    // an open deal with no next step (stuck) and an expected close date (forecast)
    await asUser(member.id, (q) =>
      q(
        `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, expected_close_date)
         select $1, 'עסקה פתוחה', 80000, p.id, s.id, $2, (now() + interval '20 days')::date
           from public.pipelines p join public.stages s on s.pipeline_id = p.id and s.kind = 'open'
          where p.organization_id = $1 and p.is_default order by s.position limit 1`,
        [org, member.id],
      ),
    );
    // a task completed today (activity by day)
    await asUser(owner.id, (q) =>
      q("insert into public.tasks (organization_id, title, owner_id, status, completed_at) values ($1, 'משימה', $2, 'done', now())", [org, owner.id]),
    );

    // an open deal whose expected close date has passed (goal forecast: overdue_deals)
    await asUser(member.id, (q) =>
      q(
        `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, expected_close_date)
         select $1, 'עסקה באיחור', 30000, p.id, s.id, $2, (now() - interval '20 days')::date
           from public.pipelines p join public.stages s on s.pipeline_id = p.id and s.kind = 'open'
          where p.organization_id = $1 and p.is_default order by s.position limit 1`,
        [org, member.id],
      ),
    );
    // a goal of this month (goal progress)
    await asUser(owner.id, (q) =>
      q(
        `insert into public.goals (organization_id, scope, period, period_start, metric, target)
         values ($1, 'org', 'month', date_trunc('month', now() at time zone 'Asia/Jerusalem')::date, 'won_amount', 500000)`,
        [org],
      ),
    );

    // meetings (CAL-11): a held meeting on the won deal before it closed (led to a deal), a no-show
    // of the member and a cancelled one
    await asUser(owner.id, async (q) => {
      await q(
        `insert into public.meetings (organization_id, title, starts_at, ends_at, status, deal_id)
         values ($1, 'פגישת סגירה', now() - interval '3 hours', now() - interval '2 hours', 'held', $2)`,
        [org, wonDeal],
      );
      await q(
        `insert into public.meetings (organization_id, title, starts_at, ends_at, status)
         values ($1, 'פגישה שבוטלה', now() - interval '5 hours', now() - interval '4 hours', 'cancelled')`,
        [org],
      );
    });
    await asUser(member.id, (q) =>
      q(
        `insert into public.meetings (organization_id, title, starts_at, ends_at, status)
         values ($1, 'הלקוח לא הגיע', now() - interval '6 hours', now() - interval '5 hours', 'no_show')`,
        [org],
      ),
    );
    // CON-06: a referral, and the referred contact won a deal (report_referrals)
    await asUser(owner.id, async (q) => {
      const referrer = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'מפנה') returning id", [org])).rows[0].id;
      const referred = (await q<{ id: string }>("insert into public.contacts (organization_id, first_name) values ($1, 'מופנה') returning id", [org])).rows[0].id;
      await q(
        "insert into public.contact_relations (organization_id, contact_id, related_contact_id, type_id) select $1, $2, $3, t.id from public.contact_relation_types t where t.organization_id = $1 and t.key = 'referral'",
        [org, referrer, referred],
      );
      await q(
        `insert into public.deals (organization_id, name, amount_agorot, pipeline_id, stage_id, owner_id, contact_id)
         select $1, 'עסקה מהפניה', 40000, p.id, s.id, $2, $3
           from public.pipelines p join public.stages s on s.pipeline_id = p.id and s.kind = 'won'
          where p.organization_id = $1 and p.is_default limit 1`,
        [org, owner.id, referred],
      );
    });

    const range = [org, from(), to()];
    const calls: Record<ReportFunction, [string, unknown[]]> = {
      report_leads_by_source: ["public.report_leads_by_source($1, $2, $3)", range],
      report_funnel: ["public.report_funnel($1, $2, $3)", range],
      report_response_time: ["public.report_response_time($1, $2, $3)", range],
      report_response_breakdown: ["public.report_response_breakdown($1, $2, $3)", range],
      report_rep_performance: ["public.report_rep_performance($1, $2, $3)", range],
      report_activity: ["public.report_activity($1, $2, $3)", range],
      report_forecast: ["public.report_forecast($1)", [org]],
      report_lost_reasons: ["public.report_lost_reasons($1, $2, $3)", range],
      report_meetings: ["public.report_meetings($1, $2, $3)", range],
      report_cycle_length: ["public.report_cycle_length($1, $2, $3)", range],
      report_stuck_deals: ["public.report_stuck_deals($1)", [org]],
      report_revenue: ["public.report_revenue($1, $2, $3)", range],
      report_revenue_by_product: ["public.report_revenue_by_product($1, $2, $3)", range],
      report_summary: ["public.report_summary($1, $2, $3, $4, $5)", [...range, new Date(Date.now() - 30 * 86_400_000).toISOString(), from()]],
      report_goal_progress: ["public.report_goal_progress($1)", [org]],
      report_goal_forecast: ["public.report_goal_forecast($1)", [org]],
      report_pipeline_cleanup: ["public.report_pipeline_cleanup($1)", [org]],
      report_money_waiting: ["public.report_money_waiting($1)", [org]],
      report_referrals: ["public.report_referrals($1, $2, $3)", range],
    };
    for (const name of REPORT_FUNCTIONS) {
      const [sql, params] = calls[name];
      results.set(name, await asUser(owner.id, async (q) => (await q<{ r: unknown }>(`select ${sql} as r`, params)).rows[0].r));
    }

    if (process.env.UPDATE_REPORT_FIXTURES === "1") {
      mkdirSync(FIXTURES, { recursive: true });
      const ids = new Map<string, string>();
      const stable = (value: unknown): unknown => {
        if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) {
          if (!ids.has(value)) ids.set(value, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
          return ids.get(value);
        }
        if (Array.isArray(value)) return value.map(stable);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stable(v)]));
        return value;
      };
      for (const [name, data] of results) {
        writeFileSync(path.join(FIXTURES, `${name}.json`), `${JSON.stringify(stable(data), null, 2)}\n`);
      }
    }
  });

  it("a lost deal with no stage history is a stage-less row that passes the schema", () => {
    const lost = parseReportData("report_lost_reasons", results.get("report_lost_reasons"));
    expect(lost.by_stage).toContainEqual({ stage_id: null, name: null, position: null, deals: 1 });
    // pipeline order, the stage-less row last
    expect(lost.by_stage[lost.by_stage.length - 1].position).toBeNull();
  });

  it.each(REPORT_FUNCTIONS.map((name) => [name]))("%s matches the app's schema and the saved sample", (name) => {
    const data = results.get(name);
    expect(() => parseReportData(name, data)).not.toThrow();
    const sample = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8"));
    expect(keyPaths(data)).toEqual(keyPaths(sample));
  });
});

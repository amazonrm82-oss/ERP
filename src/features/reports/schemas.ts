// FXC-12: the shape of every public.report_* result, checked before the app shapes it.
// A renamed or missing key used to read as zero; now it stops the report with a clear
// message. Keys the SQL adds are allowed here (z.object strips them) but fail the
// database test 89-report-shapes, which compares every result with its saved sample in
// tests/unit/fixtures/reports/. Change the SQL, this file and the sample together.

import { z } from "zod";

import { GOAL_METRIC_KEYS, GOAL_PERIODS, GOAL_SCOPES, type GoalMetric } from "@/features/goals/metrics";
import { SUPPORT_LINE } from "@/lib/support-phone";

const count = z.number().int().nonnegative();
const amount = z.number();
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const id = uuid.nullable();
const text = z.string().nullable();
const decimal = z.number().nullable();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

const stage = z.object({ stage_id: id, name: text, position: z.number() });

const responseMeasures = {
  leads: count,
  contacted: count,
  within_target: count,
  avg_minutes: decimal,
  median_minutes: decimal,
};

const forecastLine = z.object({ deals: count, amount, weighted: amount });
const forecastSplit = { deals: count, amount, weighted: amount, month_weighted: amount, overdue_deals: count, overdue_weighted: amount };

// MNY-05 / MNY-01: the open deals that need a decision (report_pipeline_cleanup's rows)
const cleanupDeals = z.array(
  z.object({
    id: uuid,
    name: text,
    owner_id: id,
    pipeline_id: uuid,
    stage_id: uuid,
    stage_name: text,
    stage_position: z.number(),
    amount_agorot: amount,
    contact_id: id,
    expected_close_date: day.nullable(),
    days_in_stage: count,
    limit_days: count,
    last_activity_at: text,
    idle_days: count,
    stuck: z.boolean(),
    overdue: z.boolean(),
  }),
);

export const REPORT_SCHEMAS = {
  report_leads_by_source: z.array(
    z.object({ source_id: id, source_name: text, campaign: text, leads: count, converted: count, won: count, revenue: amount }),
  ),
  report_funnel: z.object({
    leads: z.object({ created: count, contacted: count, converted: count, won: count }),
    pipeline_id: id,
    stages: z.array(stage.extend({ reached: count })),
    deals: z.object({ deals: count, won: count, lost: count }),
  }),
  report_response_time: z.array(z.object({ owner_id: id, within_hour: count, ...responseMeasures })),
  report_response_breakdown: z.object({
    target_minutes: z.number().positive(),
    by_source: z.array(z.object({ source_id: id, source_name: text, ...responseMeasures })),
    by_hour: z.array(z.object({ hour: z.number().int().min(0).max(23), ...responseMeasures })),
  }),
  report_rep_performance: z.array(
    z.object({ owner_id: id, won: count, lost: count, won_amount: amount, open_count: count, open_amount: amount }),
  ),
  report_activity: z.object({
    by_user: z.array(
      z.object({ user_id: id, note: count, call: count, meeting: count, messages: count, tasks_done: count }),
    ),
    by_day: z.array(z.object({ day, activities: count, tasks_done: count })),
  }),
  report_forecast: z.array(z.object({ month: day.nullable(), deals: count, amount, weighted: amount })),
  report_lost_reasons: z.object({
    by_reason: z.array(z.object({ reason: text, deals: count, amount })),
    // the stage a deal was lost from comes from its stage-change history; a deal with none
    // (created lost, or moved before history was kept) has no stage: id, name and position null
    by_stage: z.array(z.object({ stage_id: id, name: text, position: z.number().nullable(), deals: count })),
    by_owner: z.array(z.object({ owner_id: id, deals: count, amount })),
    by_competitor: z.array(z.object({ competitor: text, deals: count, amount })),
  }),
  // CAL-11: meetings that START in the period, per organizer; no_show_rate is null below no_show_min
  // meetings held or missed; "led" = a held meeting with one deal picked (its own, its lead's conversion
  // deal, else its contact's deal created after it) won within led_window_days of its start; each deal
  // once per organizer and once in totals
  report_meetings: z.object({
    led_window_days: count,
    no_show_min: count,
    totals: z.object({
      meetings: count,
      held: count,
      no_show: count,
      no_show_rate: decimal,
      cancelled: count,
      not_updated: count,
      upcoming: count,
      led_meetings: count,
      won_deals: count,
      won_amount: amount,
    }),
    by_owner: z.array(
      z.object({
        owner_id: id,
        meetings: count,
        held: count,
        no_show: count,
        no_show_rate: decimal,
        cancelled: count,
        not_updated: count,
        upcoming: count,
        led_meetings: count,
        won_deals: count,
        won_amount: amount,
      }),
    ),
    deals: z.array(z.object({ deal_id: uuid, name: text, amount, closed_at: z.string(), owner_id: id, meetings: count })),
  }),
  report_cycle_length: z.object({
    won: count,
    avg_days: decimal,
    median_days: decimal,
    from_lead: count,
    avg_days_from_lead: decimal,
    stages: z.array(stage.extend({ avg_days: decimal, moves: count })),
  }),
  // DEAL-01 (stuck by time in stage): stuck and postponed replace idle
  report_stuck_deals: z.array(
    z.object({
      id: uuid,
      name: text,
      owner_id: id,
      pipeline_id: id,
      stage_name: text,
      amount_agorot: amount,
      limit_days: count,
      stage_entered_at: text,
      days_in_stage: count,
      snoozed_until: text,
      last_activity_at: text,
      idle_days: count,
      next_task_at: text,
      next_meeting_at: text,
      stuck: z.boolean(),
      postponed: z.boolean(),
      no_next_step: z.boolean(),
    }),
  ),
  report_revenue: z.object({
    by_month: z.array(z.object({ month: day, deals: count, amount })),
    by_owner: z.array(z.object({ owner_id: id, deals: count, amount })),
    by_customer: z.array(z.object({ name: text, company_id: id, contact_id: id, deals: count, amount })),
  }),
  // RPT-01: the lines of the deals won in the period, by product and billing; stored line totals
  report_revenue_by_product: z.object({
    totals: z.object({
      deals: count,
      deals_with_lines: count,
      products: count,
      deals_without_lines: count,
      amount_without_lines: amount,
      deals_with_vat: count,
      deals_without_vat: count,
    }),
    // one total per billing (null = a line saved before DLI-04, in its deal's period); never added together
    by_billing: z.array(z.object({ billing: z.enum(["one_time", "monthly", "quarterly", "yearly"]).nullable(), lines: count, deals: count, amount })),
    by_product: z.array(
      z.object({
        product_id: id,
        name: text,
        billing: z.enum(["one_time", "monthly", "quarterly", "yearly"]).nullable(),
        quantity: z.number(),
        deals: count,
        amount,
      }),
    ),
  }),
  report_summary: z.object({
    leads: count,
    leads_prev: count,
    won: count,
    won_prev: count,
    won_amount: amount,
    won_amount_prev: amount,
    lost: count,
    lost_prev: count,
    open: count,
    open_amount: amount,
    weighted_amount: amount,
    overdue_tasks: count,
  }),
  // GOL-04: open deals weighted by expected close month against the month's won_amount goal
  report_goal_forecast: z.object({
    today: day,
    goal_scope: z.enum(["org", "user"]),
    // the caller sees every deal the goal is about; false (or a pipeline picked): goal is null
    complete: z.boolean(),
    months: z.array(z.object({ month: day, deals: count, amount, weighted: amount, won_amount: amount, goal: amount.nullable() })),
    overdue: forecastLine,
    undated: forecastLine,
    by_owner: z.array(z.object({ owner_id: id, ...forecastSplit })),
    by_stage: z.array(stage.extend({ pipeline_id: id, pipeline_name: text, ...forecastSplit })),
    overdue_deals: z.array(
      z.object({ id: uuid, name: text, owner_id: id, pipeline_id: uuid, stage_name: text, amount_agorot: amount, weighted: amount, expected_close_date: day }),
    ),
  }),
  // MNY-05: open deals that need a decision (stuck, or past the expected close date; postponed ones left out),
  // each once; the totals split them once each (overdue = overdue and not stuck)
  report_pipeline_cleanup: z.object({
    today: day,
    stuck: z.object({ deals: count, amount }),
    overdue: z.object({ deals: count, amount }),
    deals: cleanupDeals,
  }),
  // MNY-01: the main number (deals to close: the cleanup's stuck and overdue, each once) and, apart,
  // the estimate of unhandled leads by the average won deal (null with fewer than five in 90 days)
  report_money_waiting: z.object({
    today: day,
    to_close: z.object({ deals: count, amount }),
    stuck: z.object({ deals: count, amount }),
    overdue: z.object({ deals: count, amount }),
    deals: cleanupDeals,
    estimate: z.object({
      leads: count,
      won_deals: count,
      average: amount.nullable(),
      amount: amount.nullable(),
      days: count,
      min_deals: count,
    }),
    leads: z.array(
      z.object({
        id: uuid,
        full_name: text,
        company_name: text,
        phone: text,
        phone_e164: text,
        email: text,
        owner_id: id,
        created_at: z.string(),
      }),
    ),
  }),
  // GOL-03: one row per goal the caller reads, with what was done in its period
  report_goal_progress: z.array(
    z.object({
      goal_id: uuid,
      scope: z.enum(GOAL_SCOPES),
      user_id: id,
      team_id: id,
      period: z.enum(GOAL_PERIODS),
      period_start: day,
      metric: z.enum(GOAL_METRIC_KEYS as [GoalMetric, ...GoalMetric[]]),
      target: count,
      actual: count,
      elapsed: z.number().min(0).max(1),
    }),
  ),
  // CON-06: referrals made in the period, by the contact who referred
  report_referrals: z.object({
    totals: z.object({ referrals: count, referrers: count, customers: count, won_amount: amount }),
    by_referrer: z.array(
      z.object({ referrer_id: uuid, referrer_kind: z.enum(["contact", "lead"]), name: text, referred: count, customers: count, won_amount: amount }),
    ),
  }),
} as const;

export type ReportFunction = keyof typeof REPORT_SCHEMAS;
export type ReportData<N extends ReportFunction> = z.infer<(typeof REPORT_SCHEMAS)[N]>;

export const REPORT_FUNCTIONS = Object.keys(REPORT_SCHEMAS) as ReportFunction[];

/** What the person sees when a report result does not have the expected shape. */
export const REPORT_SHAPE_MESSAGE = `לא הצלחנו להציג את הדוח: הנתונים שהתקבלו לא במבנה שהמערכת מכירה. הנתונים שלכם לא נפגעו. נסו שוב מאוחר יותר, ואם זה חוזר, פנו אלינו (${SUPPORT_LINE}).`;

/** A report result that failed its schema. `details` (paths only, no values) is for the server log. */
export class ReportShapeError extends Error {
  readonly report: ReportFunction;
  readonly details: string;

  constructor(report: ReportFunction, error: z.ZodError) {
    super(REPORT_SHAPE_MESSAGE);
    this.name = "ReportShapeError";
    this.report = report;
    this.details = error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
      .join("; ");
  }
}

/** The result of one report function, checked; throws ReportShapeError when it does not match. */
export function parseReportData<N extends ReportFunction>(name: N, data: unknown): ReportData<N> {
  const result = REPORT_SCHEMAS[name].safeParse(data);
  if (!result.success) {
    throw new ReportShapeError(name, result.error);
  }
  return result.data as ReportData<N>;
}

/** Every key path of a JSON value (array items merged, "[]" for an item), sorted: the shape without the values. */
export function keyPaths(value: unknown, prefix = ""): string[] {
  const paths = new Set<string>();
  const walk = (v: unknown, at: string) => {
    if (Array.isArray(v)) {
      for (const item of v) walk(item, `${at}[]`);
    } else if (v && typeof v === "object") {
      for (const [key, child] of Object.entries(v)) {
        const path = at ? `${at}.${key}` : key;
        paths.add(path);
        walk(child, path);
      }
    }
  };
  walk(value, prefix);
  return [...paths].sort();
}

/** Runs a report; a shape mismatch is logged and comes back as the Hebrew message instead of a thrown error. Other errors still throw. */
export async function withReportShape<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    if (error instanceof ReportShapeError) {
      // paths and issue codes only: no customer values in the log
      console.error(`report shape mismatch in ${error.report}: ${error.details}`);
      return { ok: false, message: error.message };
    }
    throw error;
  }
}

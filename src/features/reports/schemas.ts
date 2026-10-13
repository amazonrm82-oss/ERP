// FXC-12: the shape of every public.report_* result, checked before the app shapes it.
// A renamed or missing key used to read as zero; now it stops the report with a clear
// message. Keys the SQL adds are allowed here (z.object strips them) but fail the
// database test 89-report-shapes, which compares every result with its saved sample in
// tests/unit/fixtures/reports/. Change the SQL, this file and the sample together.

import { z } from "zod";

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

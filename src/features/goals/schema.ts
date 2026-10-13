import { z } from "zod";

import { isUuid } from "@/lib/paths";

import { GOAL_METRIC_KEYS, GOAL_PERIODS, GOAL_SCOPES, periodStartOf, type GoalMetric } from "./metrics";

const day = z.string().regex(/^(20\d\d|2100)-(0[1-9]|1[0-2])-01$/);

const subject = z
  .object({ scope: z.enum(GOAL_SCOPES), subjectId: z.string().nullable() })
  .refine((v) => (v.scope === "org" ? v.subjectId === null : isUuid(v.subjectId)), { message: "subject" });

const periodAndStart = z
  .object({ period: z.enum(GOAL_PERIODS), periodStart: day, metric: z.enum(GOAL_METRIC_KEYS as [GoalMetric, ...GoalMetric[]]) })
  .refine((v) => periodStartOf(v.period, v.periodStart) === v.periodStart, { message: "period_start" });

/** One cell of the grid: who, which period, which metric, and the text typed (empty = no goal). */
export const goalCellArg = z.intersection(subject, periodAndStart).and(z.object({ value: z.string().max(40) }));
export type GoalCellArg = z.infer<typeof goalCellArg>;

/** Copy the previous period's goals into one column. */
export const goalCopyArg = periodAndStart;
export type GoalCopyArg = z.infer<typeof goalCopyArg>;

/** The rows the grid shows (the copy fills only these). */
export const goalRowsArg = z.array(subject).max(2000);
export type GoalRowsArg = z.infer<typeof goalRowsArg>;

// MNY-05, the weekly pipeline cleanup: pure rules (no server imports, so unit tests and client
// code can use them).

import { isRestDay, type CalendarSettings } from "@/features/calendar-days/holidays";
import { lastActivityText } from "@/features/deals/stuck-text";
import { addDays, startOfWeek } from "@/lib/calendar-grid";
import { formatDate } from "@/lib/format";

export type CleanupStage = { id: string; name: string; position: number };

/** One row of public.report_pipeline_cleanup, as the screen uses it. */
export type CleanupDeal = {
  id: string;
  name: string;
  ownerId: string | null;
  ownerName: string | null;
  pipelineId: string;
  stageId: string;
  stageName: string | null;
  stagePosition: number;
  amount: number;
  contactId: string | null;
  expected: string | null;
  daysInStage: number;
  limitDays: number;
  lastActivityAt: string | null;
  idleDays: number;
  stuck: boolean;
  overdue: boolean;
};

/**
 * The open stage a deal advances to by default: the first open stage after its own (by
 * position); null when its stage is the last open one (then the person picks, or closes it as won).
 */
export function nextOpenStage(openStages: readonly CleanupStage[], currentId: string): CleanupStage | null {
  const sorted = [...openStages].sort((a, b) => a.position - b.position);
  const current = sorted.find((stage) => stage.id === currentId);
  if (!current) return sorted[0] ?? null;
  return sorted.find((stage) => stage.position > current.position && stage.id !== currentId) ?? null;
}

/** The open stages a deal can be moved to (all but its own), in pipeline order. */
export function advanceChoices(openStages: readonly CleanupStage[], currentId: string): CleanupStage[] {
  return [...openStages].sort((a, b) => a.position - b.position).filter((stage) => stage.id !== currentId);
}

/**
 * The day of the week the cleanup is offered on the home screen: the business's first working
 * day of the week (the week starts on Sunday; CAL-03 rest days and holidays). null when the
 * whole week is days off.
 */
export function cleanupDayOfWeek(today: string, settings: CalendarSettings): string | null {
  const start = startOfWeek(today);
  for (let i = 0; i < 7; i += 1) {
    const day = addDays(start, i);
    if (!isRestDay(day, settings)) return day;
  }
  return null;
}

/** Is today the day the home screen offers the weekly cleanup. */
export function isCleanupDay(today: string, settings: CalendarSettings): boolean {
  return cleanupDayOfWeek(today, settings) === today;
}

const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** Why a deal is on the list, in words: stuck, past its close date, and when it was last touched. */
export function cleanupReasons(deal: Pick<CleanupDeal, "stuck" | "overdue" | "daysInStage" | "limitDays" | "expected" | "lastActivityAt" | "idleDays">, format: (n: number) => string): string[] {
  const parts: string[] = [];
  if (deal.stuck) parts.push(`${format(whole(deal.daysInStage))} ימים בשלב (מעל ${format(whole(deal.limitDays))})`);
  if (deal.overdue && deal.expected) parts.push(`תאריך הסגירה עבר: ${formatDate(`${deal.expected}T12:00:00Z`)}`);
  parts.push(lastActivityText({ last_activity_at: deal.lastActivityAt, idle_days: deal.idleDays }, format));
  return parts;
}

/** The home card's line: how many deals wait for a decision. */
export function cleanupCountText(count: number, format: (n: number) => string): string {
  return count === 1 ? "עסקה אחת מחכה להחלטה" : `${format(count)} עסקאות מחכות להחלטה`;
}

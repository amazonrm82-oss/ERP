import { z } from "zod";

import { LOCALE } from "@/lib/app";

// HEB-09: "stop everything". While a business has paused, no automatic message goes to its customers
// (app.customer_sending_paused, migration customer_sending_pause); messages to the staff go on.

export const PAUSE_REASON_MAX = 500;

export const pauseSchema = z.object({
  reason: z.preprocess(
    (value) => (typeof value === "string" ? value.replace(/\r\n?/g, "\n").trim() : ""),
    z
      .string()
      .min(1, { error: "יש לכתוב סיבה קצרה, למשל: יום אבל." })
      .refine((value) => [...value].length <= PAUSE_REASON_MAX, { error: `הסיבה ארוכה מדי (עד ${PAUSE_REASON_MAX} תווים).` }),
  ),
});

export type SendingPause = {
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
  pausedBy: string | null;
  resumedAt: string | null;
  resumedBy: string | null;
};

export const NOT_PAUSED: SendingPause = { paused: false, reason: null, pausedAt: null, pausedBy: null, resumedAt: null, resumedBy: null };

type Row = { paused: boolean; reason: string | null; paused_at: string | null; paused_by: string | null; resumed_at: string | null; resumed_by: string | null };

/** The stored row as the screens take it; no row = not paused. */
export function pauseFromRow(row: Row | null | undefined): SendingPause {
  if (!row) return NOT_PAUSED;
  return {
    paused: row.paused === true,
    reason: row.reason,
    pausedAt: row.paused_at,
    pausedBy: row.paused_by,
    resumedAt: row.resumed_at,
    resumedBy: row.resumed_by,
  };
}

/** The banner's line, for every member while sending is paused. */
export function pauseBannerText(pause: SendingPause, pausedAtText: string | null): string | null {
  if (!pause.paused) return null;
  const since = pausedAtText ? ` מאז ${pausedAtText}` : "";
  const reason = pause.reason ? ` (${pause.reason})` : "";
  return `השליחה האוטומטית ללקוחות מושהית${since}${reason}. הודעות לצוות ממשיכות כרגיל.`;
}

/** A pause or resume time in the business's own zone (review L-3); "" for none or an invalid time. */
export function pauseTimeText(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short", timeZone }).format(at);
  } catch {
    // a zone the runtime does not know (the database refuses those, RVW-58): the app's default
    return new Intl.DateTimeFormat(LOCALE, { dateStyle: "medium", timeStyle: "short" }).format(at);
  }
}

/**
 * The line a collection reminder task carries in its description when the job made it while sending to customers was
 * paused (owner, answer (45) א; migration collection_reminder_paused_line writes it). The task's WhatsApp button shows it.
 */
export const COLLECTION_PAUSED_LINE = "השליחה ללקוחות עצורה";

/** True for a collection reminder task the job made during a pause. */
export function madeWhilePaused(description: string | null | undefined): boolean {
  return (description ?? "").includes(COLLECTION_PAUSED_LINE);
}

import type { Json } from "@/lib/database.types";
import { formatDate } from "@/lib/format";

// BIL-08 partial: what public.trial_end_notice() answers. null = nothing to say: the switch is
// off, or the business is not in a trial-end transition (then an ended trial looks like its plan).
// The days are the business's local calendar days the changes really happen on (YYYY-MM-DD).
export type TrialEndNotice = { phase: "grace" | "read_only"; readOnlyOn: string; closesOn: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseTrialEndNotice(data: Json | null): TrialEndNotice | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { phase, read_only_on: readOnlyOn, closes_on: closesOn } = data as Record<string, Json>;
  if (phase !== "grace" && phase !== "read_only") return null;
  if (typeof readOnlyOn !== "string" || !DAY.test(readOnlyOn) || typeof closesOn !== "string" || !DAY.test(closesOn)) return null;
  return { phase, readOnlyOn, closesOn };
}

// a calendar day, shown as that day whatever the zone (noon UTC is the same date in Israel)
const day = (value: string) => formatDate(`${value}T12:00:00Z`);

/** The line at the top of every page while the business is in the transition. */
export function trialEndBannerText(notice: TrialEndNotice): string {
  return notice.phase === "grace"
    ? `תקופת הניסיון הסתיימה. ב-${day(notice.readOnlyOn)} העסק עובר לקריאה בלבד, אם לא תיבחר חבילה עד אז.`
    : `תקופת הניסיון הסתיימה, והעסק במצב קריאה בלבד. ב-${day(notice.closesOn)} הגישה לעסק תיסגר עד לתשלום, אם לא תיבחר חבילה עד אז.`;
}

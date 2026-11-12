import { z } from "zod";

import { normalizeQrTargetUrl, qrTargetUrlOk } from "@/features/qr-codes/target-url";

// RET-02 (owner (273) and the spec's note on Google's review policy): a request for a review after a won deal or a held
// meeting. Owner (307) ב, 12 November 2026: the review page may be on Google, Facebook, easy, Zap or any other site, so the
// link rule is exactly BIZ-03's QR link rule (https, ASCII, no user name, a DNS host), reused, not copied. It mirrors
// app.review_url_ok() (migration review_url_any_https); both read tests/unit/fixtures/review-urls.json.

/** Whether a stored link may be the business's review link (= app.review_url_ok = the QR link rule). */
export function reviewUrlOk(url: string): boolean {
  return qrTargetUrlOk(url);
}

/** Review (5): a new or changed link is at most this long (= app.review_request_url_max()). */
export const REVIEW_URL_MAX = 300;
export const REVIEW_URL_LONG_MESSAGE = `הקישור ארוך מדי (עד ${REVIEW_URL_MAX} תווים). העתיקו קישור קצר יותר לדף הביקורות.`;

export const REVIEW_URL_MESSAGE =
  "צריך קישור לדף הביקורות של העסק שמתחיל ב-https://, למשל ב-Google, בפייסבוק, ב-easy או בזאפ.";

/** What a person typed, as the link to store (the browser's form, https:// added when missing), or a message. */
export function normalizeReviewUrl(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const normalized = normalizeQrTargetUrl(input);
  if (!normalized.ok) return { ok: false, message: normalized.problem === "empty" ? "יש להדביק את הקישור לביקורת." : REVIEW_URL_MESSAGE };
  if (!reviewUrlOk(normalized.url)) return { ok: false, message: REVIEW_URL_MESSAGE };
  return normalized.url.length > REVIEW_URL_MAX ? { ok: false, message: REVIEW_URL_LONG_MESSAGE } : { ok: true, url: normalized.url };
}

export const REVIEW_DELAY_MAX = 30;
/** Lead's choice: a person (a contact, or a lead with a held meeting, owner (309) ב) is asked at most once in this many days (= app.review_request_gap_days()). */
export const REVIEW_REQUEST_GAP_DAYS = 90;

export type ReviewRequestSettings = {
  enabled: boolean;
  reviewUrl: string | null;
  onDealWon: boolean;
  onMeetingHeld: boolean;
  delayDays: number;
};

/** No row = off, with the table's defaults. */
export const REVIEW_REQUEST_DEFAULTS: ReviewRequestSettings = {
  enabled: false,
  reviewUrl: null,
  onDealWon: true,
  onMeetingHeld: false,
  delayDays: 1,
};

export const REVIEW_REQUEST_FIELD_NAMES = ["enabled", "review_url", "on_deal_won", "on_meeting_held", "delay_days"] as const;

const ticked = z.preprocess((value) => value === "on", z.boolean());

export const reviewRequestSettingsSchema = z
  .object({
    enabled: ticked,
    review_url: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
    on_deal_won: ticked,
    on_meeting_held: ticked,
    delay_days: z.preprocess(
      (value) => (typeof value === "string" && value.trim() !== "" ? Number(value.trim()) : undefined),
      z
        .number({ error: "יש לכתוב אחרי כמה ימים לשלוח." })
        .int({ error: "מספר שלם של ימים." })
        .min(0, { error: `בין 0 ל-${REVIEW_DELAY_MAX} ימים.` })
        .max(REVIEW_DELAY_MAX, { error: `בין 0 ל-${REVIEW_DELAY_MAX} ימים.` }),
    ),
  })
  .transform((value, ctx) => {
    let url: string | null = null;
    if (value.review_url.trim() !== "") {
      const normalized = normalizeReviewUrl(value.review_url);
      if (!normalized.ok) {
        ctx.addIssue({ code: "custom", path: ["review_url"], message: normalized.message });
        return z.NEVER;
      }
      url = normalized.url;
    }
    if (value.enabled && url === null) {
      ctx.addIssue({ code: "custom", path: ["review_url"], message: "כדי להפעיל צריך להדביק את הקישור לביקורת." });
      return z.NEVER;
    }
    if (value.enabled && !value.on_deal_won && !value.on_meeting_held) {
      ctx.addIssue({ code: "custom", path: ["on_deal_won"], message: "כדי להפעיל צריך לבחור לפחות מתי לשלוח." });
      return z.NEVER;
    }
    return { ...value, review_url: url };
  });

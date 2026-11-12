import { z } from "zod";

import { normalizeQrTargetUrl, qrTargetUrlOk } from "@/features/qr-codes/target-url";

// RET-02 (owner (273) and the spec's note on Google's review policy): a request for a Google review after a won deal or a
// held meeting. The link rule mirrors app.review_url_ok() (migration review_requests); both read
// tests/unit/fixtures/review-urls.json, so keep the two in step. Lead's choice (strict): BIZ-03's link rule, the default port
// only, and one of Google's known review shapes (each with a closed path and only the query keys it needs), because the link
// goes out in the business's name to many customers. Never a '%', '//', '.' or '..' in the path, never a fragment, /amp/ or a
// redirect parameter (Google's redirect pages).

const MAPS_HOSTS = new Set(["www.google.com", "google.com", "www.google.co.il", "google.co.il"]);

/** A query holds only the keys its shape allows, each part key=value from a closed set (= app.review_url_query_ok). */
function queryOk(query: string | null, keys: readonly string[], required: string | null): boolean {
  if (query === null) return required === null;
  if (query === "") return false;
  const parts = query.split("&");
  if (!parts.every((part) => /^[a-z_]{1,20}=[A-Za-z0-9_.:-]{1,200}$/.test(part) && keys.includes(part.split("=")[0]))) return false;
  return required === null || parts.some((part) => part.split("=")[0] === required);
}

/** The review shapes, by host (= the shape lines of app.review_url_ok). */
function reviewShapeOk(host: string, path: string, query: string | null): boolean {
  if (host === "g.page") return /^\/r\/[A-Za-z0-9_-]+(\/review)?$/.test(path) && queryOk(query, [], null);
  if (host === "search.google.com") return path === "/local/writereview" && queryOk(query, ["placeid"], "placeid");
  if (MAPS_HOSTS.has(host)) return /^\/maps\/[A-Za-z0-9@,+_~./-]+$/.test(path) && queryOk(query, ["hl", "entry"], null);
  if (host === "maps.app.goo.gl") return /^\/[A-Za-z0-9_-]+$/.test(path) && queryOk(query, ["g_st"], null);
  if (host === "g.co") return /^\/kgs\/[A-Za-z0-9_-]+$/.test(path) && queryOk(query, [], null);
  return false;
}

/** Whether a stored link may be the business's review link (= app.review_url_ok). */
export function reviewUrlOk(url: string): boolean {
  if (!qrTargetUrlOk(url)) return false;
  const host = (/^https:\/\/([^/?#:]+)/.exec(url)?.[1] ?? "").toLowerCase();
  const port = /^https:\/\/[^/?#:]+(:[0-9]+)/.exec(url)?.[1] ?? "";
  const path = /^https:\/\/[^/?#]+([^?#]*)/.exec(url)?.[1] ?? "";
  const query = /^[^?#]*[?]([^#]*)/.exec(url)?.[1] ?? null;
  if (port !== "" && port !== ":443") return false;
  if (url.includes("#")) return false;
  // delta review: a plain path only: no percent escape, no empty segment, no '.' or '..' segment
  if (path.includes("%") || path.includes("//") || /(^|\/)\.{1,2}(\/|$)/.test(path)) return false;
  if (/\/amp(\/|$)/i.test(path)) return false;
  if (/(^|&)(q|url|continue|adurl|pcurl|redirect|dest|next)=/i.test(query ?? "")) return false;
  return reviewShapeOk(host, path, query);
}

export const REVIEW_URL_MESSAGE = "צריך קישור לביקורת ב-Google, למשל https://g.page/r/…/review. מעתיקים אותו מפרופיל העסק ב-Google, מ\"קבלת ביקורות\".";

/** What a person typed, as the link to store (the browser's form, https:// added when missing), or a message. */
export function normalizeReviewUrl(input: string): { ok: true; url: string } | { ok: false; message: string } {
  const normalized = normalizeQrTargetUrl(input);
  if (!normalized.ok) return { ok: false, message: normalized.problem === "empty" ? "יש להדביק את הקישור לביקורת." : REVIEW_URL_MESSAGE };
  return reviewUrlOk(normalized.url) ? { ok: true, url: normalized.url } : { ok: false, message: REVIEW_URL_MESSAGE };
}

export const REVIEW_DELAY_MAX = 30;
/** Lead's choice: a contact is asked at most once in this many days (= app.review_request_gap_days()). */
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

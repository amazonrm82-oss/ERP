import { isPreviewBot } from "@/lib/preview-bots";
import { paths } from "@/lib/paths";

// LND-14 (owner (388) א, 16 November 2026): measurement on the landing page, counted in our own database. No cookie, no browser
// storage and no visitor id: the server counts a visit when `/` renders, a press on a sign-up button through the redirect link
// /go/signup, and a finished sign-up form for a visitor who came through that link. The only thing carried along is the source,
// from utm_source only, in a closed shape (the database folds it again: app.landing_event_source).

export const LANDING_EVENT_KINDS = ["visit", "signup_click", "signup"] as const;
export type LandingEventKind = (typeof LANDING_EVENT_KINDS)[number];

/** The query parameter that carries the folded source from /go/signup to /signup, and the sign-up form's hidden field. */
export const LANDING_SOURCE_PARAM = "src";
export const LANDING_SOURCE_FIELD = "landing_src";

/** The redirect link that counts a press on a sign-up button. */
export const SIGNUP_CLICK_PATH = "/go/signup";

const SOURCE_SHAPE = /^[a-z0-9_.-]{1,40}$/;
const SOURCE_SHAPE_ANY_CASE = /^[A-Za-z0-9_.-]{1,40}$/;

/**
 * utm_source folded to its closed shape: over 200 characters = "other"; else ASCII spaces trimmed at both ends (as SQL btrim), then [A-Za-z0-9_.-]{1,40} in lower
 * case; missing or empty after trimming = "direct"; anything else (tabs, other scripts, too long) = "other". A repeated
 * parameter takes its first value. Mirrors app.landing_event_source (shared fixture tests/unit/fixtures/landing-sources.json).
 */
export function landingSource(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "direct";
  // far too long to be a source: not trimmed or read further (app.landing_event_source does the same)
  if (value.length > 200) return "other";
  const trimmed = value.replace(/^ +| +$/g, "");
  if (trimmed === "") return "direct";
  return SOURCE_SHAPE_ANY_CASE.test(trimmed) ? trimmed.toLowerCase() : "other";
}

/** A source that already went through landingSource() (carried from /go/signup); null when the value is not one. */
export function carriedSource(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && SOURCE_SHAPE.test(value) ? value : null;
}

/** The sign-up button's link on the landing page, carrying the visit's source. */
export function signupClickHref(source: string): string {
  return `${SIGNUP_CLICK_PATH}?${LANDING_SOURCE_PARAM}=${encodeURIComponent(source)}`;
}

/** Where /go/signup sends the visitor: the sign-up page, with the source for the sign-up count and (WEB-02) the chosen plan. */
export function signupHrefWithSource(source: string | null, plan: string | null = null): string {
  const params = new URLSearchParams();
  if (source) params.set(LANDING_SOURCE_PARAM, source);
  if (plan) params.set(SIGNUP_PLAN_PARAM, plan);
  const query = params.toString();
  return query ? `${paths.signup}?${query}` : paths.signup;
}

/**
 * WEB-02: the plan a price card's sign-up button carries, as the query parameter on /go/signup and /signup and the sign-up
 * form's hidden field. Only its shape is judged here; the sign-up page shows it only while the plan is available, and the
 * database honours it at business creation only while the plan is available (public.create_organization).
 */
export const SIGNUP_PLAN_PARAM = "plan";
export const SIGNUP_PLAN_FIELD = "signup_plan";

const PLAN_KEY_SHAPE = /^[a-z][a-z0-9_]{0,39}$/;

/** A plan key in its closed shape (first value of a repeated parameter); null for anything else. */
export function signupPlanKey(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && PLAN_KEY_SHAPE.test(value) ? value : null;
}

/** A sign-up link with the price card's plan added (WEB-02), keeping its other parameters. */
export function signupHrefWithPlan(href: string, plan: string): string {
  const key = signupPlanKey(plan);
  if (!key) return href;
  const [path, query = ""] = href.split("?", 2);
  const params = new URLSearchParams(query);
  params.set(SIGNUP_PLAN_PARAM, key);
  return `${path}?${params.toString()}`;
}

/**
 * Search-engine crawlers and uptime monitors that would fetch `/` and inflate the visits (LND-14 review). A closed list of
 * product tokens, plus a generic rule: a whole word "bot", "crawler" or "spider", or a token ending in "bot/<version>". A phone
 * model such as "CUBOT" is not a whole word "bot" and is not caught.
 */
export const CRAWLER_AGENTS: readonly RegExp[] = [
  /\bGooglebot\b/i,
  /\bbingbot\b/i,
  /\bApplebot\b/i,
  /\bYandexBot\b/i,
  /\bDuckDuckBot\b/i,
  /\bBaiduspider\b/i,
  /\bAhrefsBot\b/i,
  /\bSemrushBot\b/i,
  /\bMJ12bot\b/i,
  /\bDotBot\b/i,
  /\bPetalBot\b/i,
  /\bUptimeRobot\b/i,
  /\bPingdom/i,
  /\bStatusCake\b/i,
  /\bAdsBot-Google\b/i,
  /\bBytespider\b/i,
  /\bGoogle-InspectionTool\b/i,
  /\bGoogleOther\b/i,
  /\bHeadlessChrome\b/i,
  /^curl\//i,
  /^Wget\//i,
  /^python-requests\//i,
  /^Go-http-client\//i,
  /^node-fetch\b/i,
  /^axios\//i,
  /\b(?:bot|crawler|spider)\b/i,
  /bot\/\d/i,
];

/** The longest User-Agent a person's browser is taken to send; a longer one is never a visit. */
export const USER_AGENT_MAX = 1000;

/**
 * The User-Agent is a crawler, an uptime monitor or a script client of the closed list, or is over USER_AGENT_MAX characters
 * (judged before any pattern, so every pattern runs on at most 1,000 characters; the patterns are plain words, linear).
 */
export function isCrawler(userAgent: string | null | undefined): boolean {
  if ((userAgent ?? "").length > USER_AGENT_MAX) return true;
  const ua = (userAgent ?? "").trim();
  if (ua === "") return false;
  return CRAWLER_AGENTS.some((rule) => rule.test(ua));
}

/**
 * Whether a sign-up answer is a NEW account (LND-14 review): Auth returned a user with an identity, made within the last 60
 * seconds. A repeat sign-up of an address that already has an account (confirmed or not) carries the account's old created_at,
 * or no identity, and is not counted.
 */
export function isNewSignupAccount(user: { created_at?: string | null; identities?: unknown[] | null } | null | undefined, now: Date = new Date()): boolean {
  if (!user || !Array.isArray(user.identities) || user.identities.length === 0) return false;
  const created = typeof user.created_at === "string" ? Date.parse(user.created_at) : Number.NaN;
  if (!Number.isFinite(created)) return false;
  // The 60 s window (LND-14 delta review): a person who sends the form again within it after a new account was made is answered
  // with the same new account and is counted again, bounded by the sender limit (5 sign-ups per sender in 10 minutes in the
  // database). A clock that drifts more than 60 s between our server and Auth makes a real sign-up not counted (an undercount).
  const age = now.getTime() - created;
  return age >= -60_000 && age <= 60_000;
}

/**
 * A request that is not a person looking: a browser or router prefetch (Purpose / Sec-Purpose: prefetch or prerender, Next's
 * router prefetch headers), a link-preview fetcher on the closed list of src/lib/preview-bots.ts, or a crawler or uptime monitor
 * (isCrawler). Never counted.
 */
export function notAVisit(headers: Headers): boolean {
  if (headers.get("next-router-prefetch") || headers.get("next-router-segment-prefetch")) return true;
  for (const name of ["purpose", "sec-purpose", "x-purpose", "x-moz"]) {
    const value = (headers.get(name) ?? "").toLowerCase();
    if (value.includes("prefetch") || value.includes("prerender") || value.includes("preview")) return true;
  }
  const ua = headers.get("user-agent");
  return isPreviewBot(ua) || isCrawler(ua);
}

/**
 * WEB-02: the plan a sign-up page shows and carries: only a key of a plan that is available right now (from the price list's
 * cached public.plans_public answer). A coming-soon, hidden or unknown key, or no answer, is ignored silently (null).
 */
export function availableSignupPlan(
  plans: readonly { key: string; name: string; availability: string; priceMonthlyAgorot?: number; priceAnnualAgorot?: number }[] | null,
  raw: unknown,
): { key: string; name: string; free: boolean } | null {
  const key = signupPlanKey(raw);
  if (!key || !plans) return null;
  const plan = plans.find((p) => p.key === key && p.availability === "available");
  // WEB-02 (402) ב: both prices zero = the business starts active with no trial (the database decides it again at creation)
  return plan ? { key: plan.key, name: plan.name, free: plan.priceMonthlyAgorot === 0 && plan.priceAnnualAgorot === 0 } : null;
}

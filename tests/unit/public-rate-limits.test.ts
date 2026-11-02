import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isPublicPath } from "@/lib/supabase/proxy";
import { RATE_LIMIT_RETRY_SECONDS, RATE_LIMITED_TEXT, rateLimitedJson, rateLimitedText } from "@/lib/public-rate-limit";

// OPS-02: the inventory of every path a visitor reaches without a session (src/lib/supabase/proxy.ts, isPublicPath), and
// what limits it. A new public page or route fails the first test until it is added here with its limit named. The limits
// live in the database (each public function counts per link and/or per sender with the FXS-11 keyed IP hash), so they
// hold across every server instance; a route only maps the "rate limited" answer to the shared reply of
// src/lib/public-rate-limit.ts.

type Guard =
  /** a service_role definer function limits it in the database (functions named) */
  | "database"
  /** a shared secret in the Authorization header; only the database calls it */
  | "secret"
  /** Supabase Auth's own limits (sign-in, sign-up, e-mail sends, code checks) */
  | "supabase-auth"
  /** the same static text for everyone, from code only; nothing per visitor is read */
  | "static";

type Entry = {
  guard: Guard;
  /** the public SQL functions it calls (database guard only) */
  functions?: string[];
  /** the limit as it stands, in words (window, per link / per sender / in total, before or after the token lookup) */
  limit: string;
  /** what the visitor gets when refused */
  refusal: string;
};

const PAGE_TEXT = "page text RATE_LIMITED_PAGE_TEXT (HTTP 200: a page cannot answer 429)";
const JSON_429 = "429 JSON {ok:false, message: RATE_LIMITED_TEXT}, Retry-After 600";
const TEXT_429 = "429 text, Retry-After 600";
const PREVIEW = "a listed preview bot (src/lib/preview-bots.ts) gets only link_preview_public: 300/min in total, 120 per sender across all links and 30 per sender and link in 10 min, counted BEFORE the lookup (not found included); refused = the generic preview";

export const PUBLIC_ENTRY_POINTS: Record<string, Entry> = {
  "/": { guard: "static", limit: "landing page, no database read", refusal: "none" },
  "/login": { guard: "supabase-auth", limit: "Supabase Auth sign-in limits per IP (the server forwards X-Forwarded-For)", refusal: "form message (errors.ts over_request_rate_limit)" },
  "/signup": { guard: "supabase-auth", limit: "Supabase Auth sign-up and e-mail send limits", refusal: "form message (over_email_send_rate_limit)" },
  "/forgot-password": { guard: "supabase-auth", limit: "Supabase Auth e-mail send limit (429 is shown, 'no such user' is not)", refusal: "form message" },
  "/auth/callback": { guard: "supabase-auth", limit: "Supabase Auth code / OTP verification limits", refusal: "redirect to /login with an error" },
  "/help": { guard: "static", limit: "help center from code", refusal: "none" },
  "/help/[slug]": { guard: "static", limit: "help center from code", refusal: "none" },
  "/legal/[doc]": { guard: "static", limit: "legal texts from code", refusal: "none" },
  "/legal/subprocessors": {
    guard: "database",
    functions: ["subprocessors_public_page"],
    limit: "no visitor input; cached an hour (unstable_cache); the function answers 60 reads a minute in total; a failed read backs off a minute",
    refusal: "the static list of the legal version",
  },
  "/f/embed.js": { guard: "static", limit: "the same script for everyone, cached a day by browsers and CDNs", refusal: "none" },
  "/f/[token]": {
    guard: "database",
    functions: ["intake_form", "link_preview_public"],
    limit: "OPS-02: 60 views per sender per form in 10 min (app.form_view_counts), counted after the token lookup; " + PREVIEW,
    refusal: PAGE_TEXT,
  },
  "/f/[token]/qr": { guard: "database", functions: ["intake_form"], limit: "the form page's view limit (shared counter)", refusal: PAGE_TEXT },
  "/api/forms/[token]": {
    guard: "database",
    functions: ["intake_form", "intake_submit"],
    limit: "10 per sender per form in 10 min and 500 per form an hour (spam and too-large bodies counted), after the token lookup",
    refusal: JSON_429 + " (CORS headers kept)",
  },
  "/api/in/[token]": { guard: "database", functions: ["intake_submit"], limit: "intake_submit's limits (webhook kind)", refusal: JSON_429 },
  "/f/book/[token]": {
    guard: "database",
    functions: ["booking_page_public", "link_preview_public"],
    limit: "60 views per sender per page in 10 min, after the lookup; views never close a page; " + PREVIEW,
    refusal: PAGE_TEXT,
  },
  "/api/forms/booking/[token]": {
    guard: "database",
    functions: ["booking_submit"],
    limit: "5 per sender per page in 10 min (spam and invalid times included); 200 real races in an hour close the page for an hour",
    refusal: JSON_429 + "; closed page: 429 with its own message and Retry-After 3600",
  },
  "/f/book/manage/[token]": {
    guard: "database",
    functions: ["booking_manage_public", "link_preview_public"],
    limit: "the booking page's view counter (60 per sender in 10 min); " + PREVIEW,
    refusal: PAGE_TEXT,
  },
  "/api/forms/booking/manage/[token]": {
    guard: "database",
    functions: ["booking_manage_cancel", "booking_manage_change"],
    limit: "app.booking_manage_begin: 5 per sender per page in 10 min, shared with bookings; the page closure applies",
    refusal: JSON_429 + "; closed page: Retry-After 3600",
  },
  "/f/card/[token]": {
    guard: "database",
    functions: ["business_card_public", "link_preview_public"],
    limit: "60 views per sender per card in 10 min, after the lookup; " + PREVIEW,
    refusal: PAGE_TEXT,
  },
  "/api/forms/card/[token]": {
    guard: "database",
    functions: ["business_card_submit", "intake_submit"],
    limit: "intake_submit's limits on the card's own form (sender scoped per card)",
    refusal: JSON_429,
  },
  "/api/forms/card/[token]/vcard": { guard: "database", functions: ["business_card_public"], limit: "a view of the card (same counter)", refusal: TEXT_429 },
  "/f/widget/[token]": { guard: "database", functions: ["site_widget_public"], limit: "60 views per sender per widget in 10 min, after the lookup", refusal: PAGE_TEXT },
  "/f/w/[file]": {
    guard: "database",
    functions: ["site_widget_public"],
    limit: "not counted per visitor on purpose (the same script for everyone): cached 5 min by browsers and CDNs (not found 1 min)",
    refusal: "none",
  },
  "/api/forms/widget/[token]": {
    guard: "database",
    functions: ["site_widget_submit", "intake_submit"],
    limit: "intake_submit's limits on the widget's own form (sender scoped per widget)",
    refusal: JSON_429,
  },
  "/f/quote/[token]": {
    guard: "database",
    functions: ["quote_public", "quote_public_version", "link_preview_public"],
    limit: "120 views per link in 10 min, after the lookup (no per-sender view limit: QUO-08 part one uses no IP for views); " + PREVIEW,
    refusal: PAGE_TEXT,
  },
  "/api/forms/quote/[token]/decide": {
    guard: "database",
    functions: ["quote_public_answer", "quote_signed_pdf_public", "quote_signed_pdf_public_store"],
    limit: "10 tries per link in 10 min plus the link's 120-view window; the signed PDF only once after an acceptance",
    refusal: JSON_429 + " (with status)",
  },
  "/api/forms/quote/[token]/question": {
    guard: "database",
    functions: ["quote_public_question"],
    limit: "the link's 120 in 10 min, 20 per link a day, 5 per sender in 10 min",
    refusal: "429 JSON with the question's own message (the window may be a day), Retry-After 600",
  },
  "/api/forms/quote/[token]/pdf": {
    guard: "database",
    functions: ["quote_public_pdf"],
    limit: "the link's 120-view window plus 20 downloads per sender in 10 min",
    refusal: TEXT_429,
  },
  "/f/order/[token]": {
    guard: "database",
    functions: ["order_public", "link_preview_public"],
    limit: "120 views per link and 60 per sender in 10 min, after the lookup; " + PREVIEW,
    refusal: PAGE_TEXT,
  },
  "/api/forms/order/[token]/decide": {
    guard: "database",
    functions: ["order_public_decide"],
    limit: "10 tries per link in 10 min plus the link's 120-view window",
    refusal: JSON_429 + " (with status)",
  },
  "/api/forms/order/[token]/pdf": {
    guard: "database",
    functions: ["order_public_pdf"],
    limit: "the link's 120-view window plus 20 downloads per sender in 10 min",
    refusal: TEXT_429,
  },
  "/f/statement/[token]": {
    guard: "database",
    functions: ["statement_public"],
    limit: "120 views per link and 60 per sender in 10 min, after the lookup; a preview bot gets a generic page and no read",
    refusal: PAGE_TEXT,
  },
  "/api/forms/statement/[token]/pdf": { guard: "database", functions: ["statement_public"], limit: "a view of the statement (same counters)", refusal: TEXT_429 },
  "/f/q/[token]": {
    guard: "database",
    functions: ["qr_scan"],
    limit: "a counter only (owner: no IP, device or visitor id): 60 counted scans per code a minute, more still redirect uncounted",
    refusal: "none (redirect or the page before an external link)",
  },
  "/api/calendar-feed/[file]": {
    guard: "database",
    functions: ["calendar_feed_events"],
    limit: "60 fetches per feed in 10 min, after the lookup",
    refusal: TEXT_429,
  },
  "/api/push/dispatch": { guard: "secret", limit: "Bearer PUSH_DISPATCH_SECRET (timing-safe); woken by pg_cron every minute", refusal: "401" },
  "/api/files/cleanup": { guard: "secret", limit: "Bearer PUSH_DISPATCH_SECRET (timing-safe); woken nightly by pg_cron", refusal: "401" },
};

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const APP = join(ROOT, "src/app");

/** Every page and route of the app as its URL pattern (route groups left out). */
function appEntries(): string[] {
  const out: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), /^\(.*\)$/.test(entry.name) ? url : `${url}/${entry.name}`);
      } else if (/^(page|route)\.tsx?$/.test(entry.name)) {
        out.push(url === "" ? "/" : url);
      }
    }
  };
  walk(APP, "");
  return out.sort();
}

/** A sample address of a pattern, so the proxy's prefix rule can judge it. */
const sample = (pattern: string) => pattern.replace(/\[[^\]]+\]/g, "x0");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

const migrations = readdirSync(join(ROOT, "supabase/migrations"))
  .map((f) => readFileSync(join(ROOT, "supabase/migrations", f), "utf8"))
  .join("\n");

describe("OPS-02: every public path has a named limit", () => {
  it("every page and route the proxy lets through without a session is in the inventory, and nothing else is", () => {
    const publicOnes = appEntries().filter((pattern) => isPublicPath(sample(pattern)));
    expect(publicOnes).toContain("/f/[token]");
    expect(publicOnes.filter((p) => !(p in PUBLIC_ENTRY_POINTS)), "add these to PUBLIC_ENTRY_POINTS with their limit").toEqual([]);
    expect(Object.keys(PUBLIC_ENTRY_POINTS).filter((p) => !publicOnes.includes(p)), "no longer public or gone").toEqual([]);
  });

  it("a database-limited entry names functions that exist and are for the service role only", () => {
    for (const [path, entry] of Object.entries(PUBLIC_ENTRY_POINTS)) {
      expect(entry.limit.length, path).toBeGreaterThan(10);
      if (entry.guard !== "database") {
        expect(entry.functions, path).toBeUndefined();
        continue;
      }
      expect(entry.functions?.length, path).toBeGreaterThan(0);
      for (const fn of entry.functions ?? []) {
        expect(migrations, `${path}: public.${fn}`).toMatch(new RegExp(`function public\\.${fn}\\s*\\(`));
        expect(migrations, `${path}: public.${fn} granted to service_role`).toMatch(
          new RegExp(`grant execute on function public\\.${fn}\\s*\\([^)]*\\) to service_role`),
        );
      }
    }
  });

  it("no code answers 429 by hand: every rate refusal goes through src/lib/public-rate-limit.ts", () => {
    // reading a 429 (Supabase Auth's answer) is fine; the staff report export answers the PDF quota refusal of RPT-02
    const allowed = new Set([
      "src/lib/public-rate-limit.ts",
      "src/lib/auth-transient.ts",
      "src/lib/errors.ts",
      "src/features/auth/actions.ts",
      "src/app/o/[orgId]/reports/[report]/export/route.ts",
    ]);
    const offenders = sourceFiles(join(ROOT, "src"))
      .map((file) => relative(ROOT, file))
      .filter((file) => !allowed.has(file))
      .filter((file) =>
        readFileSync(join(ROOT, file), "utf8")
          .split("\n")
          .some((line) => !/^\s*(\/\/|\*)/.test(line) && /(status:\s*429|\(\s*429\b|\?\s*429\b|:\s*429\s*[,)])/.test(line)),
      );
    expect(offenders).toEqual([]);
  });

  it("the shared reply: 429, Retry-After, never cached, one Hebrew message", async () => {
    const json = rateLimitedJson({ ok: false, message: RATE_LIMITED_TEXT }, { headers: { "Access-Control-Allow-Origin": "*" } });
    expect(json.status).toBe(429);
    expect(json.headers.get("retry-after")).toBe(String(RATE_LIMIT_RETRY_SECONDS));
    expect(json.headers.get("cache-control")).toBe("no-store");
    expect(json.headers.get("access-control-allow-origin")).toBe("*");
    expect(await json.json()).toEqual({ ok: false, message: RATE_LIMITED_TEXT });

    const text = rateLimitedText(undefined, { retryAfterSeconds: 3600 });
    expect(text.status).toBe(429);
    expect(text.headers.get("retry-after")).toBe("3600");
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(await text.text()).toBe(RATE_LIMITED_TEXT);
    // a caller's header never overrides the shared ones
    expect(rateLimitedText("x", { headers: { "Cache-Control": "public" } }).headers.get("cache-control")).toBe("no-store");
  });
});

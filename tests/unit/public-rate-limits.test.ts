import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
  | "static"
  /**
   * no limit on purpose: it answers a constant and reads nothing. The functions it names are called with the anon key, take no
   * argument, read no table and answer a constant (checked by the test; tests/db/289 pins the body and grants)
   */
  | "constant";

type Entry = {
  guard: Guard;
  /** the public SQL functions its page or route calls through `.rpc("<name>"` (database and constant guards only; checked by the test) */
  functions?: string[];
  /** the limit as it stands, in words (window, per link / per sender / in total, before or after the token lookup) */
  limit: string;
  /** what the visitor gets when refused */
  refusal: string;
  /**
   * OPS-02 (owner (40) ב, (42) ד): "first" = the page or route checks the secret-link pages' shared per-sender limit
   * (public.public_sender_check: 120 "not found" answers per sender in 10 minutes across them) before anything that reads its
   * token, and records a miss after a "not found" (public.public_sender_miss); else why it is left out (database guard only;
   * checked by the test)
   */
  sender?: "first" | { leftOut: string };
};

const PAGE_TEXT = "page text RATE_LIMITED_PAGE_TEXT (HTTP 200: a page cannot answer 429)";
const JSON_429 = "429 JSON {ok:false, message: RATE_LIMITED_TEXT}, Retry-After 600";
const TEXT_429 = "429 text, Retry-After 600";
const SENDER = "OPS-02: first the shared limit of the secret-link pages: refused BEFORE the token lookup once the sender had 120 \"not found\" answers in 10 min across them (public_sender_check / public_sender_miss); found answers never count; ";
const OUT_42 = "(42) ד: published to everyone (lead form, widget, booking page; the business card by the lead's call), so only its own limits apply";
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
    sender: { leftOut: "no token and no visitor input: one cached read for everyone, with its own total limit" },
  },
  "/f/embed.js": { guard: "static", limit: "the same script for everyone, cached a day by browsers and CDNs", refusal: "none" },
  "/f/[token]": {
    guard: "database",
    functions: ["intake_form", "link_preview_public"],
    limit: "300 views per sender per form in 10 min (app.form_view_limit, app.form_view_counts), counted after the token lookup; " + PREVIEW,
    refusal: PAGE_TEXT,
    sender: { leftOut: OUT_42 },
  },
  "/f/[token]/qr": { guard: "database", functions: ["intake_form"], limit: "the form page's view limit (shared counter)", refusal: PAGE_TEXT, sender: { leftOut: OUT_42 } },
  "/api/forms/[token]": {
    guard: "database",
    functions: ["intake_form", "intake_submit"],
    limit: "10 per sender per form in 10 min and 500 per form an hour (spam and too-large bodies counted), after the token lookup",
    refusal: JSON_429 + " (CORS headers kept)",
    sender: { leftOut: OUT_42 },
  },
  "/api/in/[token]": {
    guard: "database",
    functions: ["intake_submit"],
    limit: "intake_submit's limits (webhook kind)",
    refusal: JSON_429,
    sender: { leftOut: "(43) א: server-to-server webhook (Zapier, Make, plugins): their servers post for many businesses from shared addresses; the token is a secret" },
  },
  "/f/book/[token]": {
    guard: "database",
    functions: ["booking_page_public", "link_preview_public"],
    limit: "60 views per sender per page in 10 min, after the lookup; views never close a page; " + PREVIEW,
    refusal: PAGE_TEXT,
    sender: { leftOut: OUT_42 },
  },
  "/api/forms/booking/[token]": {
    guard: "database",
    functions: ["booking_submit"],
    limit: "5 per sender per page in 10 min (spam and invalid times included); 200 real races in an hour close the page for an hour",
    refusal: JSON_429 + "; closed page: 429 with its own message and Retry-After 3600",
    sender: { leftOut: OUT_42 },
  },
  "/f/book/manage/[token]": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "booking_manage_public", "link_preview_public"],
    limit: SENDER + "the booking page's view counter (60 per sender in 10 min); " + PREVIEW,
    refusal: PAGE_TEXT,
    sender: "first",
  },
  "/api/forms/booking/manage/[token]": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "booking_manage_cancel", "booking_manage_change"],
    limit: SENDER + "app.booking_manage_begin: 5 per sender per page in 10 min, shared with bookings; the page closure applies",
    refusal: JSON_429 + "; closed page: Retry-After 3600",
    sender: "first",
  },
  "/f/card/[token]": {
    guard: "database",
    functions: ["business_card_public", "link_preview_public"],
    limit: "60 views per sender per card in 10 min, after the lookup; " + PREVIEW,
    refusal: PAGE_TEXT,
    sender: { leftOut: OUT_42 },
  },
  "/api/forms/card/[token]": {
    guard: "database",
    functions: ["business_card_submit"],
    limit: "business_card_submit goes through intake_submit in the database: its limits on the card's own form (sender scoped per card)",
    refusal: JSON_429,
    sender: { leftOut: OUT_42 },
  },
  "/api/forms/card/[token]/vcard": {
    guard: "database",
    functions: ["business_card_public"],
    limit: "a view of the card (same counter)",
    refusal: TEXT_429,
    sender: { leftOut: OUT_42 },
  },
  "/f/widget/[token]": {
    guard: "database",
    functions: ["site_widget_public"],
    limit: "60 views per sender per widget in 10 min, after the lookup",
    refusal: PAGE_TEXT,
    sender: { leftOut: OUT_42 },
  },
  "/f/w/[file]": {
    guard: "database",
    functions: ["site_widget_public"],
    limit: "not counted per visitor on purpose (the same script for everyone): cached 5 min by browsers and CDNs (not found 1 min)",
    refusal: "none",
    sender: { leftOut: OUT_42 },
  },
  "/api/forms/widget/[token]": {
    guard: "database",
    functions: ["site_widget_submit"],
    limit: "site_widget_submit goes through intake_submit in the database: its limits on the widget's own form (sender scoped per widget)",
    refusal: JSON_429,
    sender: { leftOut: OUT_42 },
  },
  "/f/quote/[token]": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "quote_public", "quote_public_version", "link_preview_public"],
    limit: SENDER + "120 views per link and (owner (41) ב) 60 per sender in 10 min (x-crm-sender, scope quote, app.quote_link_view_counts), after the lookup; " + PREVIEW,
    refusal: PAGE_TEXT,
    sender: "first",
  },
  "/api/forms/quote/[token]/decide": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "quote_public_answer", "quote_signed_pdf_public", "quote_signed_pdf_public_store"],
    limit: SENDER + "10 tries per link in 10 min plus the link's 120-view window; the signed PDF only once after an acceptance",
    refusal: JSON_429 + " (with status)",
    sender: "first",
  },
  "/api/forms/quote/[token]/question": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "quote_public_question"],
    limit: SENDER + "the link's 120 in 10 min, 20 per link a day, 5 per sender in 10 min",
    refusal: "429 JSON with the question's own message (the window may be a day), Retry-After 600",
    sender: "first",
  },
  "/api/forms/quote/[token]/pdf": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "quote_public_pdf"],
    limit: SENDER + "the link's 120-view window plus 20 downloads per sender in 10 min",
    refusal: TEXT_429,
    sender: "first",
  },
  "/f/order/[token]": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "order_public", "link_preview_public"],
    limit: SENDER + "120 views per link and 60 per sender in 10 min, after the lookup; " + PREVIEW,
    refusal: PAGE_TEXT,
    sender: "first",
  },
  "/api/forms/order/[token]/decide": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "order_public_decide"],
    limit: SENDER + "10 tries per link in 10 min plus the link's 120-view window",
    refusal: JSON_429 + " (with status)",
    sender: "first",
  },
  "/api/forms/order/[token]/pdf": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "order_public_pdf"],
    limit: SENDER + "the link's 120-view window plus 20 downloads per sender in 10 min",
    refusal: TEXT_429,
    sender: "first",
  },
  "/f/statement/[token]": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "statement_public"],
    limit: SENDER + "120 views per link and 60 per sender in 10 min, after the lookup; a preview bot gets a generic page and no read",
    refusal: PAGE_TEXT,
    sender: "first",
  },
  "/api/forms/statement/[token]/pdf": {
    guard: "database",
    functions: ["public_sender_check", "public_sender_miss", "statement_public"],
    limit: SENDER + "a view of the statement (same counters)",
    refusal: TEXT_429,
    sender: "first",
  },
  "/f/privacy/[token]": {
    guard: "database",
    functions: ["privacy_request_page"],
    limit: "60 per sender (keyed IP hash, scope privacy, IPv6 by its /64, re-scoped per business, 1,024 buckets, no hash kept), then 300 per link, in 10 min, after the lookup",
    refusal: PAGE_TEXT,
    sender: { leftOut: "PRK-02: published by the business in its privacy notice for anyone to use (like the lead form, (42) ד), so only its own limits apply" },
  },
  "/api/forms/privacy/[token]": {
    guard: "database",
    functions: ["privacy_request_submit"],
    limit: "3 tries per sender in 10 min and 10 a day (honeypot hits included, never stored), then 50 stored requests per link a day, after the lookup",
    refusal: JSON_429,
    sender: { leftOut: "PRK-02: published by the business in its privacy notice for anyone to use (like the lead form, (42) ד), so only its own limits apply" },
  },
  "/f/q/[token]": {
    guard: "database",
    functions: ["qr_scan"],
    limit: "a counter only (owner: no IP, device or visitor id): 60 counted scans per code a minute, more still redirect uncounted",
    refusal: "none (redirect or the page before an external link)",
    sender: { leftOut: "(43) א: scans are a counter only by the owner's rule (BIZ-03, 13 October 2026): no IP, device or visitor id, so no sender is counted" },
  },
  "/api/calendar-feed/[file]": {
    guard: "database",
    functions: ["calendar_feed_events"],
    limit: "60 fetches per feed in 10 min, after the lookup",
    refusal: TEXT_429,
    sender: { leftOut: "(43) א: fetched by calendar servers (Google, Apple, Outlook) that poll many people's feeds from shared addresses; the token is a secret" },
  },
  "/api/push/dispatch": { guard: "secret", limit: "Bearer PUSH_DISPATCH_SECRET (timing-safe); woken by pg_cron every minute", refusal: "401" },
  "/api/files/cleanup": { guard: "secret", limit: "Bearer PUSH_DISPATCH_SECRET (timing-safe); woken nightly by pg_cron", refusal: "401" },
  "/api/health": {
    guard: "constant",
    functions: ["health_check"],
    limit: "no limit: answers a constant, reads nothing (OPS-05, owner (72) ב: the anon key calls public.health_check(), which answers true and reads no table; the reply is only {ok} with no-store)",
    refusal: "none (503 {ok:false} when the database does not answer true within 3 s)",
  },
  "/api/jobs/run": { guard: "secret", limit: "Bearer PUSH_DISPATCH_SECRET (timing-safe); woken by pg_cron every minute while jobs are due", refusal: "401" },
  "/api/meta/leads": {
    guard: "database",
    functions: ["meta_lead_receive", "meta_lead_claim", "meta_lead_finish"],
    limit:
      "CAP-11: POST refused (401) BEFORE the database unless X-Hub-Signature-256 is the HMAC of the raw body with META_APP_SECRET (timing-safe), bodies over 256 KB refused (413); then 100 lead ids a request and 1,000 new ones per connection an hour (app.meta_lead_receive_counts), a lead id taken once per business; intake_submit's 500 per form an hour; GET answers only the challenge against META_VERIFY_TOKEN and reads nothing",
    refusal: JSON_429 + " (Meta sends it again; what was taken is not taken twice); 401 / 403 / 413 / 503",
    sender: { leftOut: "(43) א: server-to-server from Meta's servers, which post for many businesses from shared addresses; the signature is the secret" },
  },
  "/api/meta/leads/sweep": { guard: "secret", limit: "Bearer PUSH_DISPATCH_SECRET (timing-safe); woken by pg_cron every 5 minutes while a Meta lead is due", refusal: "401" },
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

/** The page or route file of a URL pattern (route groups searched too). */
function entryFile(pattern: string): string {
  const files: string[] = [];
  const walk = (dir: string, url: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, /^\(.*\)$/.test(entry.name) ? url : `${url}/${entry.name}`);
      else if (/^(page|route)\.tsx?$/.test(entry.name) && (url === "" ? "/" : url) === pattern) files.push(path);
    }
  };
  walk(APP, "");
  if (files.length !== 1) throw new Error(`${pattern}: ${files.length} files`);
  return files[0];
}

const IMPORT = /\bfrom\s+"(@\/[^"]+|\.{1,2}\/[^"]+)"/g;

/** The file and every file of src/ it imports, directly or not (the code a request to it can run). */
function importClosure(start: string): Map<string, string> {
  const seen = new Map<string, string>();
  const resolve = (spec: string, from: string): string | null => {
    const base = spec.startsWith("@/") ? join(ROOT, "src", spec.slice(2)) : join(from, "..", spec);
    const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")];
    return candidates.find((candidate) => /\.tsx?$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) ?? null;
  };
  const stack = [start];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    for (const match of text.matchAll(IMPORT)) {
      const next = resolve(match[1], file);
      if (next && !seen.has(next)) stack.push(next);
    }
  }
  return seen;
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

const migrationFiles = readdirSync(join(ROOT, "supabase/migrations")).map((name) => ({
  name,
  text: readFileSync(join(ROOT, "supabase/migrations", name), "utf8"),
}));
const migrations = migrationFiles.map((f) => f.text).join("\n");

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
      if (entry.guard === "constant") {
        // OPS-05: called with the anon key, no argument, no table read, a constant answer
        expect(entry.limit, path).toMatch(/^no limit: answers a constant, reads nothing/);
        expect(entry.sender, path).toBeUndefined();
        expect(entry.functions?.length, path).toBeGreaterThan(0);
        const code = [...importClosure(entryFile(path)).values()].join("\n");
        expect(code, `${path} never uses the service key`).not.toMatch(/supabase\/service|SERVICE_ROLE/);
        // the route and what it imports reach the database only through the named functions: no other rpc, no table, no auth
        const rpcs = [...code.matchAll(/\.rpc\(\s*([^)]*)\)/g)].map((m) => m[1].trim());
        expect(rpcs.length, `${path} calls the database`).toBeGreaterThan(0);
        for (const call of rpcs) expect((entry.functions ?? []).map((fn) => `"${fn}"`), `${path}: .rpc(${call})`).toContain(call);
        expect(code, `${path} reads no table`).not.toMatch(/\.from\(/);
        expect(code, `${path} touches no auth`).not.toMatch(/\.auth\./);
        for (const fn of entry.functions ?? []) {
          expect(rpcs, `${path} calls .rpc("${fn}")`).toContain(`"${fn}"`);
          // judged in each migration file that defines it, never across files joined
          const defining = migrationFiles.filter((f) => new RegExp(`function public\\.${fn}\\s*\\(`).test(f.text));
          expect(defining.length, `${path}: a migration defines public.${fn}`).toBeGreaterThan(0);
          for (const file of defining) {
            const defs = [...file.text.matchAll(new RegExp(`create or replace function public\\.${fn}\\s*\\([\\s\\S]*?\\$\\$;`, "g"))];
            expect(defs.length, `${file.name}: public.${fn} is created once`).toBe(1);
            expect(defs[0][0], `${file.name}: public.${fn}() answers the constant true`).toMatch(
              new RegExp(`^create or replace function public\\.${fn}\\(\\)\\s*returns boolean\\s+language sql\\s+stable\\s+security invoker\\s+set search_path = ''\\s+as \\$\\$\\s*select true\\s*\\$\\$;$`),
            );
            expect(file.text, `${file.name}: public.${fn} granted to anon`).toMatch(
              new RegExp(`grant execute on function public\\.${fn}\\s*\\(\\) to anon`),
            );
          }
        }
        continue;
      }
      if (entry.guard !== "database") {
        expect(entry.functions, path).toBeUndefined();
        continue;
      }
      expect(entry.functions?.length, path).toBeGreaterThan(0);
      const code = [...importClosure(entryFile(path)).values()].join("\n");
      for (const fn of entry.functions ?? []) {
        // the page or route really reaches it: an .rpc("<fn>" call in the file or in what it imports
        expect(new RegExp(`\\.rpc\\(\\s*"${fn}"`).test(code), `${path} calls .rpc("${fn}"`).toBe(true);
        expect(migrations, `${path}: public.${fn}`).toMatch(new RegExp(`function public\\.${fn}\\s*\\(`));
        expect(migrations, `${path}: public.${fn} granted to service_role`).toMatch(
          new RegExp(`grant execute on function public\\.${fn}\\s*\\([^)]*\\) to service_role`),
        );
      }
    }
  });

  it("OPS-02 (40), (42): every secret-link page and route takes the shared sender limit before anything that reads the database", () => {
    // the helpers of src/lib/public-sender-server.ts; the preview-bot path is left out on purpose (WAB-05 counts it first)
    const HELPERS = ["guardPublicPage", "guardPublicRoute"];
    const PREVIEW_PATH = new Set(["isPreviewBotRequest", "loadBotPreview", "botPreviewMetadata", "BotPreviewPage"]);
    const resolve = (spec: string, from: string): string | null => {
      const base = spec.startsWith("@/") ? join(ROOT, "src", spec.slice(2)) : join(from, "..", spec);
      return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((c) => existsSync(c)) ?? null;
    };
    const IMPORTS = /^import\s+(?!type\b)\{([^}]*)\}\s+from\s+"([^"]+)";/gm;
    for (const [path, entry] of Object.entries(PUBLIC_ENTRY_POINTS)) {
      if (entry.guard !== "database") continue;
      expect(entry.sender, `${path}: say "first" or why it is left out`).toBeDefined();
      const file = entryFile(path);
      const text = readFileSync(file, "utf8");
      const body = text.replace(IMPORTS, "");
      const helperAt = Math.min(...HELPERS.map((h) => body.indexOf(`${h}(`)).filter((i) => i >= 0));
      if (entry.sender !== "first") {
        expect((entry.sender as { leftOut: string }).leftOut.length, path).toBeGreaterThan(20);
        expect(entry.functions, `${path} is left out: it does not name the shared limit`).not.toContain("public_sender_check");
        expect(Number.isFinite(helperAt), `${path} is left out but calls the helper`).toBe(false);
        continue;
      }
      expect(entry.functions, path).toEqual(expect.arrayContaining(["public_sender_check", "public_sender_miss"]));
      expect(Number.isFinite(helperAt), `${path} calls guardPublicPage() or guardPublicRoute()`).toBe(true);
      // a route counts a miss only for a response its handler marked "not found" (src/lib/public-not-found.ts)
      if (file.endsWith("route.ts")) {
        const reached = [...importClosure(file).entries()].filter(([f]) => !f.endsWith("public-not-found.ts")).map(([, code]) => code);
        expect(reached.some((code) => /markNotFound\(/.test(code)), `${path} marks its "not found" answer`).toBe(true);
      }
      // every function imported from a module that reaches the database (.rpc) is first called after the helper
      for (const match of text.matchAll(IMPORTS)) {
        const source = resolve(match[2], file);
        if (!source) continue;
        const reaches = [...importClosure(source).values()].some((code) => /\.rpc\(/.test(code));
        if (!reaches) continue;
        for (const raw of match[1].split(",")) {
          const name = raw.replace(/^\s*type\s+/, "").split(/\s+as\s+/).pop()?.trim();
          if (!name || HELPERS.includes(name) || PREVIEW_PATH.has(name) || /^[A-Z_]+$/.test(name)) continue;
          const at = body.search(new RegExp(`(?<![\\w.])${name}\\(`));
          if (at < 0) continue;
          expect(at, `${path}: ${name}() runs only after the shared sender limit`).toBeGreaterThan(helperAt);
        }
      }
    }
  });

  it("no code answers 429 by hand: every rate refusal goes through src/lib/public-rate-limit.ts", () => {
    // any 429 outside a comment counts (a literal status, a named constant, a ternary): only the helper holds one. Reading a
    // 429 (Supabase Auth's answer) is fine in these files; the staff report export answers the PDF quota refusal of RPT-02
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
          .some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && /\b429\b/.test(line.replace(/\/\/.*$/, ""))),
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

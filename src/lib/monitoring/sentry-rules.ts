import { cleanLogPath, redactText } from "@/lib/log";
import { redactPublicPath } from "@/lib/request-error-log";

// OPS-05 (owner 18 November 2026; DECISIONS.md "ניטור תקלות: Sentry"): the rules every Sentry event passes, shared by the
// browser, the Node server and the edge runtime. Pure: no Sentry import, no Node import, so the unit tests read it directly
// and the browser can load it. What leaves for Sentry: the error's name, its redacted message and stack frames, the route,
// the path without its query and with a public link's token hidden, the request id and the ids of the user and the business.
// Never headers, cookies, a request body, a query string, an email, a phone, a name or an IP address.
//
// Owner (427) א: nothing is sent before the day in SENTRY_ACTIVE_FROM (an Israel date, the subprocessor entry's first day,
// migration 021322). The gate is judged at run time for every event, so a long-lived server or page opens on the day by itself;
// unset, empty or malformed = closed for good.

/** The business day the gate is judged in (the subprocessor notice counts Israel days). */
export const SENTRY_TIME_ZONE = "Asia/Jerusalem";

/** Public customer pages: Sentry is never loaded there, the CSP gives them no Sentry host, and nothing is sent from them. */
export function isCustomerPagePath(pathname: string): boolean {
  return pathname === "/f" || pathname.startsWith("/f/");
}

/** Only in Vercel's production and only with a DSN: anything else (preview, development, tests, no DSN) = off. */
export function sentryConfigured(dsn: string | undefined | null, environment: string | undefined | null): boolean {
  return typeof dsn === "string" && dsn.trim() !== "" && environment === "production";
}

/** The YYYY-MM-DD of SENTRY_ACTIVE_FROM when it is a real calendar day, else null (= closed). */
export function parseActiveFrom(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const day = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, date));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== date) return null;
  return day;
}

/** Today's date in Israel as YYYY-MM-DD. */
export function israelDay(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: SENTRY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Whether events may be sent now: from Israel midnight of SENTRY_ACTIVE_FROM. Unset or malformed = never. */
export function sentryOpen(activeFrom: string | undefined | null, now: Date = new Date()): boolean {
  const day = parseActiveFrom(activeFrom);
  return day !== null && israelDay(now) >= day;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only user context an event carries: the user id and the business id, each only when it is a uuid. */
export type MonitoringIdentity = { userId: string | null; orgId: string | null };

export function cleanIdentity(identity: Partial<MonitoringIdentity> | null | undefined): MonitoringIdentity {
  const id = (value: unknown) => (typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null);
  return { userId: id(identity?.userId), orgId: id(identity?.orgId) };
}

/** The business id of an app path (/o/<uuid>/...), else null. */
export function orgIdFromPath(pathname: string): string | null {
  const match = /^\/o\/([0-9a-f-]{36})(?:\/|$)/i.exec(pathname);
  return match ? cleanIdentity({ orgId: match[1] }).orgId : null;
}

/** A URL or path for an event: no query or fragment, the public link's token and token-like segments hidden. */
export function scrubUrl(value: string): string {
  let origin = "";
  let path = value;
  const absolute = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)(.*)$/i.exec(value);
  if (absolute) {
    origin = absolute[1].replace(/\/\/[^@/]*@/, "//");
    path = absolute[2] || "/";
  }
  return `${origin}${cleanLogPath(path)}`;
}

// The shape of a Sentry event as far as these rules touch it (structurally compatible with ErrorEvent / TransactionEvent).
type Frame = { filename?: string; abs_path?: string; vars?: unknown };
type Mechanism = {
  type?: string;
  handled?: boolean;
  synthetic?: boolean;
  source?: string;
  exception_id?: number;
  parent_id?: number;
  is_exception_group?: boolean;
  data?: unknown;
};
type Exception = { type?: string; value?: string; stacktrace?: { frames?: Frame[] }; mechanism?: Mechanism };
export type MonitorEvent = {
  message?: string;
  logentry?: { message?: string; params?: unknown[] };
  exception?: { values?: Exception[] };
  request?: { url?: string; method?: string; headers?: unknown; cookies?: unknown; data?: unknown; query_string?: unknown; env?: unknown };
  user?: unknown;
  breadcrumbs?: unknown;
  extra?: unknown;
  transaction?: string;
  tags?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  server_name?: string;
  fingerprint?: unknown;
};

/**
 * A stack frame's file: a build file (a chunk name of 16+ characters is the file's own name and must stay, or the frame never
 * meets its source map), so only the query and fragment are dropped and a public link's token in a page URL becomes [token].
 */
export function scrubFramePath(value: string): string {
  const bare = value.split("?")[0].split("#")[0];
  const absolute = /^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i.exec(bare);
  if (!absolute) return redactPublicPath(bare);
  return `${absolute[1].replace(/\/\/[^@/]*@/, "//")}${redactPublicPath(absolute[2] || "/")}`;
}

// a run of letters outside ASCII (Hebrew, Arabic, Cyrillic...), with their marks and the spaces between such words
const NON_ASCII_WORDS = /(?:[^\P{L}A-Za-z]|\p{M})+(?:[\s'"\u05F3\u05F4-]+(?:[^\P{L}A-Za-z]|\p{M})+)*/gu;

/**
 * Free text for Sentry (a third party; the subprocessor entry says no contact details): a Postgres "DETAIL:" tail dropped,
 * the values of "Key (...)=(...)" replaced by [value], then redactText (secrets, emails, phones, quoted runs), then every run
 * of non-ASCII letters (a Hebrew name, an address) replaced by [text].
 */
export function sentryText(text: string): string {
  const cut = text.replace(POSTGRES_TAIL, "").replace(/(Key \([^)]*\)=\()[^)]*\)/g, "$1[value])");
  return capText(redactText(cut).replace(NON_ASCII_WORDS, "[text]"));
}

// A Postgres report's tail: everything from DETAIL, HINT, CONTEXT, WHERE, QUERY, STATEMENT or "LINE n:" on (they can quote a row,
// the statement or the function's text).
const POSTGRES_TAIL = /\s*\b(?:DETAIL|Detail|HINT|Hint|CONTEXT|Context|WHERE|Where|QUERY|Query|STATEMENT|Statement|LINE \d+):[\s\S]*$/;

/** The longest free text an event carries (owner (436) א): cut after the scrubbing, never inside a surrogate pair. */
export const SENTRY_TEXT_MAX = 200;

function capText(text: string): string {
  if (text.length <= SENTRY_TEXT_MAX) return text;
  let end = SENTRY_TEXT_MAX;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

// a five-character SQLSTATE (Postgres) or a PostgREST code (PGRST116)
const DB_CODE = /^(?:[0-9A-Z]{5}|PGRST\d{3})$/;
// a hint our migrations write (`using hint = 'limit:max_quotes'`, 'feature:x', 'quote:frozen'); Postgres's own prose hints are dropped
const HINT_CODE = /^[a-z][a-z0-9_]*(?:[:.][a-z0-9_.-]+)*$/i;

/**
 * A database error as Sentry may see it (owner (436) א): "SQLSTATE <code>" (or "PostgREST <code>") and, when it is one of our
 * code-like hints, " hint <hint>". Never the message, details, where, query or a prose hint from the database. Null when the
 * value is not a database error: an object (an Error or a plain PostgREST answer) with a code of that shape AND the PostgREST
 * shape (a `details` or `hint` key), or a DbReadError / PostgrestError by name.
 */
export function databaseErrorSummary(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as { code?: unknown; hint?: unknown; name?: unknown };
  const code = record.code;
  if (typeof code !== "string" || !DB_CODE.test(code)) return null;
  const shaped = "details" in record || "hint" in record || record.name === "DbReadError" || record.name === "PostgrestError";
  if (!shaped) return null;
  const label = code.startsWith("PGRST") ? `PostgREST ${code}` : `SQLSTATE ${code}`;
  const hint = typeof record.hint === "string" && record.hint.length <= 100 && HINT_CODE.test(record.hint) ? record.hint : null;
  return hint ? `${label} hint ${hint}` : label;
}

/** The captured error and the errors it was caused by, in the order LinkedErrors walks them (at most 10). */
function causeChain(original: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = original;
  while (current !== null && typeof current === "object" && chain.length < 10 && !chain.includes(current)) {
    chain.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** An error's name as Sentry writes it in `exception.type` (a plain object has none). */
function errorTypeName(value: unknown): string | null {
  return value instanceof Error ? value.name || null : null;
}

/** The tags an event may carry: ours (codes and ids) and the SDK's own plain ones. Any other tag is dropped. */
const TAG_KEYS = new Set(["org_id", "digest", "route", "route_type", "method", "request_id", "runtime", "environment", "level", "release"]);
const TAG_VALUE = /^[A-Za-z0-9_.:/()@[\]?-]{1,128}$/;
/** Contexts that describe the machine, never the person or the request. */
const CONTEXT_KEYS = new Set(["os", "runtime", "browser", "app", "device", "culture", "cloud_resource", "nextjs"]);

function scrubFrames(frames: Frame[] | undefined): void {
  for (const frame of frames ?? []) {
    delete frame.vars;
    if (typeof frame.filename === "string") frame.filename = scrubFramePath(frame.filename);
    if (typeof frame.abs_path === "string") frame.abs_path = scrubFramePath(frame.abs_path);
  }
}

/** The fields an exception value may keep: its type, text, frames and how it was caught. Anything else is dropped. */
const EXCEPTION_KEYS = new Set(["type", "value", "module", "thread_id", "stacktrace", "mechanism"]);
/** The fields of `mechanism` that say how an error was caught, never what it held (`data` is dropped). */
const MECHANISM_KEYS = new Set(["type", "handled", "synthetic", "source", "exception_id", "parent_id", "is_exception_group"]);

type ScrubOptions = {
  /** The error that was captured (Sentry's hint.originalException): a database error is sent as its code and hint only. */
  original?: unknown;
  /** SENTRY_ACTIVE_FROM as read now (server: process.env at run time; browser: the inlined value). */
  activeFrom: string | undefined | null;
  /** The user and business the event belongs to, when known; only their ids are kept. */
  identity?: Partial<MonitoringIdentity> | null;
  now?: Date;
};

/**
 * The event as it may leave, or null (nothing is sent): closed before SENTRY_ACTIVE_FROM; a database error as "SQLSTATE <code>"
 * and its code-like hint only (databaseErrorSummary); every free text at most 200 characters; and always without headers,
 * cookies, body, query, breadcrumbs, extra data, local variables, mechanism data or fingerprint; free text through
 * sentryText; a request URL and the transaction through scrubUrl, stack frame files through scrubFramePath;
 * scrubUrl; user = {id} only, the business id as the tag org_id.
 */
export function scrubEvent<E extends MonitorEvent>(event: E, options: ScrubOptions): E | null {
  if (!sentryOpen(options.activeFrom, options.now)) return null;
  if (typeof event.message === "string") event.message = sentryText(event.message);
  if (event.logentry) {
    event.logentry = typeof event.logentry.message === "string" ? { message: sentryText(event.logentry.message) } : undefined;
  }
  const values = event.exception?.values ?? [];
  // the captured error is the last value; LinkedErrors puts each cause before the error it caused
  const summaries = new Map<number, string>();
  causeChain(options.original).forEach((error, depth) => {
    const index = values.length - 1 - depth;
    const summary = databaseErrorSummary(error);
    if (index < 0 || !summary) return;
    // the captured error (a plain object too) is always the last value; a cause only when its type agrees
    if (depth === 0 || values[index].type === errorTypeName(error)) summaries.set(index, summary);
  });
  values.forEach((exception, index) => {
    const fields = exception as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) if (!EXCEPTION_KEYS.has(key)) delete fields[key];
    const summary = summaries.get(index);
    if (summary) exception.value = summary;
    else if (exception.type === "DbReadError" || exception.type === "PostgrestError") exception.value = "database error";
    else if (typeof exception.value === "string") exception.value = sentryText(exception.value);
    if (exception.mechanism) {
      const mechanism = exception.mechanism as unknown as Record<string, unknown>;
      for (const key of Object.keys(mechanism)) if (!MECHANISM_KEYS.has(key)) delete mechanism[key];
    }
    scrubFrames(exception.stacktrace?.frames);
  });
  const threads = (event as { threads?: { values?: { stacktrace?: { frames?: Frame[] } }[] } }).threads;
  for (const thread of threads?.values ?? []) scrubFrames(thread.stacktrace?.frames);
  if (event.request) {
    const url = typeof event.request.url === "string" ? scrubUrl(event.request.url) : undefined;
    const method = typeof event.request.method === "string" && /^[A-Z]{1,16}$/.test(event.request.method) ? event.request.method : undefined;
    event.request = { ...(url ? { url } : {}), ...(method ? { method } : {}) };
  }
  if (typeof event.transaction === "string") event.transaction = scrubUrl(event.transaction);
  delete event.breadcrumbs;
  delete event.extra;
  delete event.server_name;
  delete event.fingerprint;
  delete (event as { modules?: unknown }).modules;
  delete (event as { sdkProcessingMetadata?: unknown }).sdkProcessingMetadata;
  if (event.contexts) {
    for (const key of Object.keys(event.contexts)) if (!CONTEXT_KEYS.has(key)) delete event.contexts[key];
  }
  const identity = cleanIdentity(options.identity);
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    if (TAG_KEYS.has(key) && typeof value === "string" && TAG_VALUE.test(value)) tags[key] = value;
  }
  delete tags.org_id;
  if (identity.orgId) tags.org_id = identity.orgId;
  event.tags = tags;
  if (identity.userId) event.user = { id: identity.userId };
  else delete event.user;
  return event;
}

/** Breadcrumbs (log lines, fetch URLs, clicks) never leave: they can carry what the event rules take out. */
export function dropBreadcrumb(): null {
  return null;
}

/**
 * The default integrations Sentry may keep: error capture and stack handling only. Anything that reads requests, local
 * variables, log output, navigation, sessions, replays or traces is removed by name (a whitelist, so a new SDK
 * integration stays off until judged). Left out on purpose too: OnUncaughtException (its fatal handler prints the error
 * and exits the process; Next.js handles those errors and onRequestError reports them), the default OnUnhandledRejection
 * (it prints in its "warn" mode; the server adds its own in mode "none", OPS-06: src/lib/log.ts is the only writer) and
 * WinterCGFetch (it adds sentry-trace/baggage headers to the edge runtime's outgoing fetches).
 */
const KEPT_INTEGRATIONS = new Set([
  "InboundFilters",
  "EventFilters",
  "FunctionToString",
  "LinkedErrors",
  "Dedupe",
  "GlobalHandlers",
  "BrowserApiErrors",
  "ContextLines",
  "NodeContext",
  "Context",
  "NextjsClientStackFrameNormalization",
  "DistDirRewriteFrames",
  "RewriteFrames",
]);

export function keptIntegrations<I extends { name: string }>(defaults: I[]): I[] {
  return defaults.filter((integration) => KEPT_INTEGRATIONS.has(integration.name));
}

/** The Sentry ingest origin of a DSN (https://<key>@<host>/<project>) for the CSP's connect-src, or null. */
export function sentryIngestOrigin(dsn: string | undefined | null): string | null {
  if (typeof dsn !== "string" || dsn.trim() === "") return null;
  try {
    const url = new URL(dsn.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !/^[a-z0-9.-]+\.sentry\.io$/.test(host) || url.port !== "") return null;
    return `https://${host}`;
  } catch {
    return null;
  }
}

/** The options both runtimes share: no tracing, no PII; no replay, profiling, session or local-variable integration is kept. */
export function baseSentryOptions(dsn: string, environment: string) {
  return {
    dsn,
    environment,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    maxBreadcrumbs: 0,
    attachStacktrace: false,
    sendClientReports: false,
    debug: false,
    beforeBreadcrumb: dropBreadcrumb,
    // never a transaction: tracing is off, and one that slips through is dropped
    beforeSendTransaction: () => null,
    integrations: keptIntegrations,
  };
}

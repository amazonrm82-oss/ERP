import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { contentSecurityPolicy } from "@/lib/csp";
import { MONITORING_USER_HEADER, monitoringIdentityOf, monitoringUserHeaderValue } from "@/lib/monitoring/request-identity";
import {
  baseSentryOptions,
  cleanIdentity,
  dropBreadcrumb,
  isCustomerPagePath,
  israelDay,
  keptIntegrations,
  orgIdFromPath,
  parseActiveFrom,
  databaseErrorSummary,
  SENTRY_TEXT_MAX,
  scrubEvent,
  scrubFramePath,
  sentryText,
  scrubUrl,
  sentryConfigured,
  sentryIngestOrigin,
  sentryOpen,
  type MonitorEvent,
} from "@/lib/monitoring/sentry-rules";
import { DbReadError } from "@/lib/db-read";
import { sourceMapUploadReady } from "../../next.config";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

const USER = "11111111-2222-4333-8444-555555555555";
const ORG = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OPEN = { activeFrom: "2026-12-02", now: new Date("2026-12-10T10:00:00Z") };
const DSN = "https://5772cf174baba12d778a65365953851f@o4512453548965888.ingest.de.sentry.io/4512453567381584";

describe("OPS-05 gate: production, a DSN and SENTRY_ACTIVE_FROM", () => {
  it("runs only in Vercel production with a DSN", () => {
    expect(sentryConfigured(DSN, "production")).toBe(true);
    expect(sentryConfigured("", "production")).toBe(false);
    expect(sentryConfigured("   ", "production")).toBe(false);
    expect(sentryConfigured(undefined, "production")).toBe(false);
    expect(sentryConfigured(DSN, "preview")).toBe(false);
    expect(sentryConfigured(DSN, "development")).toBe(false);
    expect(sentryConfigured(DSN, undefined)).toBe(false);
  });

  it("parses only a real calendar day", () => {
    expect(parseActiveFrom("2026-12-02")).toBe("2026-12-02");
    expect(parseActiveFrom(" 2026-12-02 ")).toBe("2026-12-02");
    for (const bad of [undefined, null, "", "2026-12", "2026-13-01", "2026-02-30", "02/12/2026", "2026-12-02T00:00", "tomorrow"]) {
      expect(parseActiveFrom(bad as string | undefined)).toBeNull();
    }
  });

  it("is closed before the day and open from Israel midnight of the day", () => {
    // 2 December 2026: Israel is UTC+2, so midnight in Israel is 22:00 UTC on 1 December
    expect(israelDay(new Date("2026-12-01T21:59:59Z"))).toBe("2026-12-01");
    expect(sentryOpen("2026-12-02", new Date("2026-12-01T21:59:59Z"))).toBe(false);
    expect(sentryOpen("2026-12-02", new Date("2026-12-01T22:00:00Z"))).toBe(true);
    expect(sentryOpen("2026-12-02", new Date("2026-11-18T12:00:00Z"))).toBe(false);
    expect(sentryOpen("2026-12-02", new Date("2027-06-01T12:00:00Z"))).toBe(true);
  });

  it("is closed for good when the date is unset or malformed", () => {
    const later = new Date("2030-01-01T00:00:00Z");
    for (const bad of [undefined, null, "", "garbage", "2026-02-30"]) {
      expect(sentryOpen(bad as string | undefined, later)).toBe(false);
      expect(scrubEvent({ message: "x" }, { activeFrom: bad as string | undefined, now: later })).toBeNull();
    }
  });

  it("drops every event before the day, at run time", () => {
    expect(scrubEvent({ message: "boom" }, { activeFrom: "2026-12-02", now: new Date("2026-12-01T21:00:00Z") })).toBeNull();
    expect(scrubEvent({ message: "boom" }, { activeFrom: "2026-12-02", now: new Date("2026-12-01T22:30:00Z") })).not.toBeNull();
  });

  it("the server reads SENTRY_ACTIVE_FROM for every event, not once at start", () => {
    const server = read("src/lib/monitoring/sentry-server.ts");
    expect(server).toMatch(/beforeSend\([^)]*\)\s*\{[\s\S]*process\.env\.SENTRY_ACTIVE_FROM/);
    const register = read("src/instrumentation.ts");
    expect(register).toContain("sentryConfigured(dsn, process.env.VERCEL_ENV)");
    expect(register).toContain("parseActiveFrom(process.env.SENTRY_ACTIVE_FROM)");
    const client = read("src/instrumentation-client.ts");
    expect(client).toContain("NEXT_PUBLIC_SENTRY_ACTIVE_FROM");
    expect(client).toContain("isCustomerPagePath(window.location.pathname)");
    // the browser's module is fetched only on demand, never statically bundled into every page
    expect(client).not.toMatch(/^import .*@sentry\/nextjs/m);
    expect(client).not.toMatch(/^import .*sentry-client/m);
  });
});

describe("OPS-05 scrubbing", () => {
  it("removes headers, cookies, body, query and keeps only the url path and method", () => {
    const event: MonitorEvent = {
      request: {
        url: "https://mexuzsystem.com/o/x/leads?q=dana@example.com&token=abc#frag",
        method: "POST",
        headers: { cookie: "sb=1", authorization: "Bearer secret" },
        cookies: { sb: "1" },
        data: { phone: "0501234567" },
        query_string: "q=dana",
        env: { REMOTE_ADDR: "1.2.3.4" },
      },
    };
    const out = scrubEvent(event, OPEN)!;
    expect(out.request).toEqual({ url: "https://mexuzsystem.com/o/x/leads", method: "POST" });
  });

  it("hides a public link's token in urls, transactions and stack frames", () => {
    expect(scrubUrl("https://mexuzsystem.com/f/quote/abcdefghijklmnopqrstuvwx123?x=1")).toBe("https://mexuzsystem.com/f/quote/[token]");
    expect(scrubUrl("/f/sign/SECRETtoken1234567890/pdf")).toBe("/f/sign/[token]/pdf");
    expect(scrubUrl("https://user:pass@mexuzsystem.com/api/forms/booking/manage/tok123")).toBe("https://mexuzsystem.com/api/forms/booking/manage/[token]");
    const out = scrubEvent(
      {
        transaction: "/f/statement/abc123secrettokenvalue",
        exception: { values: [{ type: "Error", value: "x", stacktrace: { frames: [{ filename: "https://mexuzsystem.com/f/abcd1234efgh5678ijkl?x=1", vars: { a: 1 } }] } }] },
      },
      OPEN,
    )!;
    expect(out.transaction).toBe("/f/statement/[token]");
    const frame = out.exception!.values![0].stacktrace!.frames![0];
    expect(frame.filename).toBe("https://mexuzsystem.com/f/[token]");
    expect(frame.vars).toBeUndefined();
  });

  it("keeps build file names in stack frames whole, so they meet their source maps", () => {
    const out = scrubEvent(
      {
        exception: {
          values: [
            {
              type: "Error",
              value: "x",
              stacktrace: {
                frames: [
                  { filename: "https://mexuzsystem.com/_next/static/chunks/0a1b2c3d4e5f6a7b.js?dpl=dpl_abc123def456ghi789" },
                  { filename: "/var/task/.next/server/chunks/ssr/abc123def456ghi789.js", abs_path: "/var/task/.next/server/chunks/ssr/abc123def456ghi789.js#x" },
                  { filename: "https://mexuzsystem.com/f/quote/SECRETtoken1234567890?x=1" },
                ],
              },
            },
          ],
        },
      },
      OPEN,
    )!;
    const frames = out.exception!.values![0].stacktrace!.frames!;
    expect(frames[0].filename).toBe("https://mexuzsystem.com/_next/static/chunks/0a1b2c3d4e5f6a7b.js");
    expect(frames[1].filename).toBe("/var/task/.next/server/chunks/ssr/abc123def456ghi789.js");
    expect(frames[1].abs_path).toBe("/var/task/.next/server/chunks/ssr/abc123def456ghi789.js");
    expect(frames[2].filename).toBe("https://mexuzsystem.com/f/quote/[token]");
    expect(scrubFramePath("/f/abcd1234efgh5678ijkl")).toBe("/f/[token]");
  });

  it("takes Hebrew and other non-ASCII words, Postgres key values and DETAIL tails out of the text", () => {
    expect(sentryText('duplicate key value violates unique constraint "x" Key (name)=(דני כהן) already exists')).toBe(
      'duplicate key value violates unique constraint "…" Key (name)=([value]) already exists',
    );
    expect(sentryText("Key (email, phone)=(dana, 0501234567) already exists.")).toBe("Key (email, phone)=([value]) already exists.");
    expect(sentryText("insert failed DETAIL: Failing row contains (דני, dana@example.com, 050).")).toBe("insert failed");
    expect(sentryText("read failed. Detail: name was Иван")).toBe("read failed.");
    expect(sentryText("לא נמצא הלקוח דני כהן ברשומה")).toBe("[text]");
    expect(sentryText("failed for ‏דני‏ at stage 3")).not.toMatch(/[^\x00-\x7f‏]/);
    expect(sentryText("שָׁלוֹם world")).toBe("[text] world");
    expect(sentryText("Ошибка: Müller not found")).toBe("[text]: M[text]ller not found");
    const out = scrubEvent(
      {
        message: "שגיאה עבור משה",
        logentry: { message: "Key (name)=(משה) exists" },
        exception: { values: [{ type: "Error", value: "read failed: לקוח דני", mechanism: { data: { function: "x", body: "דני" } } }] },
        fingerprint: ["דני"],
      },
      OPEN,
    )!;
    expect(out.message).toBe("[text]");
    expect(out.logentry).toEqual({ message: "Key (name)=([value]) exists" });
    expect(out.exception!.values![0].value).toBe("read failed: [text]");
    expect(out.exception!.values![0].mechanism).toEqual({});
    expect(out.fingerprint).toBeUndefined();
    expect(JSON.stringify(out)).not.toMatch(/[֐-׿]/);
  });

  it("redacts emails, phones and secrets in messages and exception values", () => {
    const out = scrubEvent(
      {
        message: "failed for dana@example.com at 050-123-4567",
        logentry: { message: "user dana@example.com", params: ["dana@example.com"] },
        exception: { values: [{ type: "Error", value: "token=abc123 Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig phone +972501234567" }] },
      },
      OPEN,
    )!;
    const text = JSON.stringify(out);
    expect(text).not.toContain("dana@example.com");
    expect(text).not.toContain("050-123-4567");
    expect(text).not.toContain("972501234567");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("eyJ");
    expect(out.logentry).toEqual({ message: expect.stringContaining("[email]") });
  });

  it("drops breadcrumbs, extra data, server name, unknown contexts and tags", () => {
    const out = scrubEvent(
      {
        breadcrumbs: [{ category: "fetch", data: { url: "https://x/f/quote/tok" } }],
        extra: { body: "x" },
        server_name: "host-1",
        contexts: { os: { name: "Linux" }, response: { status_code: 500 }, trace: { trace_id: "t" } },
        tags: { route: "/o/[orgId]/leads", url: "https://x?q=dana@example.com", email: "dana@example.com", digest: "12345" },
      },
      OPEN,
    )!;
    expect(out.breadcrumbs).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(Object.keys(out.contexts!)).toEqual(["os"]);
    expect(out.tags).toEqual({ route: "/o/[orgId]/leads", digest: "12345" });
    expect(dropBreadcrumb()).toBeNull();
  });

  it("user context is the user id only, and the business id a tag", () => {
    const out = scrubEvent(
      { user: { id: "old", email: "dana@example.com", ip_address: "1.2.3.4", username: "dana" }, tags: { org_id: "forged" } },
      { ...OPEN, identity: { userId: USER.toUpperCase(), orgId: ORG } },
    )!;
    expect(out.user).toEqual({ id: USER });
    expect(out.tags).toEqual({ org_id: ORG });
    const none = scrubEvent<MonitorEvent>({ user: { email: "dana@example.com" } }, { ...OPEN, identity: { userId: "dana@example.com", orgId: "x" } })!;
    expect(none.user).toBeUndefined();
    expect(none.tags).toEqual({});
    expect(cleanIdentity({ userId: "not-a-uuid", orgId: ORG })).toEqual({ userId: null, orgId: ORG });
  });

  it("the shared options send no PII, no traces and no breadcrumbs, and keep only error integrations", () => {
    const options = baseSentryOptions(DSN, "production");
    expect(options.sendDefaultPii).toBe(false);
    expect(options.tracesSampleRate).toBe(0);
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.beforeSendTransaction()).toBeNull();
    const names = [
      "Breadcrumbs", "BrowserTracing", "BrowserSession", "Replay", "Feedback", "Http", "RequestData", "LocalVariables", "Console",
      "OnUncaughtException", "OnUnhandledRejection", "WinterCGFetch", "GlobalHandlers", "LinkedErrors", "Dedupe",
    ];
    expect(keptIntegrations(names.map((name) => ({ name }))).map((i) => i.name)).toEqual(["GlobalHandlers", "LinkedErrors", "Dedupe"]);
    // the server adds its own unhandled-rejection capture that never prints (OPS-06)
    expect(read("src/lib/monitoring/sentry-node.ts")).toContain('onUnhandledRejectionIntegration({ mode: "none" })');
    expect(read("src/instrumentation.ts")).toContain('process.env.NEXT_RUNTIME === "nodejs" ? (await import("@/lib/monitoring/sentry-node"))');
    // no replay or tracing integration is ever named in our code
    for (const file of ["src/lib/monitoring/sentry-client.ts", "src/lib/monitoring/sentry-server.ts", "src/lib/monitoring/sentry-rules.ts"]) {
      expect(read(file)).not.toMatch(/replayIntegration|browserTracingIntegration|profilingIntegration|captureRequestError/);
    }
  });
});

describe("OPS-05 identity on the server", () => {
  it("the proxy writes a user id only for a signed-in visitor of a non-public page", () => {
    expect(monitoringUserHeaderValue(USER, false)).toBe(USER);
    expect(monitoringUserHeaderValue(USER, true)).toBeNull();
    expect(monitoringUserHeaderValue("dana@example.com", false)).toBeNull();
    expect(monitoringUserHeaderValue(null, false)).toBeNull();
    const proxy = read("src/lib/supabase/proxy.ts");
    // a visitor's own header never counts
    expect(proxy).toContain("headers.delete(MONITORING_USER_HEADER)");
  });

  it("reads the user header and the business from the path, never on a customer page", () => {
    const headers = (name: string) => (name === MONITORING_USER_HEADER ? USER : null);
    expect(monitoringIdentityOf(headers, `/o/${ORG}/leads?x=1`)).toEqual({ userId: USER, orgId: ORG });
    expect(monitoringIdentityOf(headers, "/app")).toEqual({ userId: USER, orgId: null });
    expect(monitoringIdentityOf(headers, "/f/quote/tok")).toEqual({ userId: null, orgId: null });
    expect(orgIdFromPath(`/o/${ORG}`)).toBe(ORG);
    expect(orgIdFromPath("/o/not-an-id/leads")).toBeNull();
  });

  it("onRequestError keeps its log line and reports to Sentry only once started", () => {
    const source = read("src/instrumentation.ts");
    expect(source).toContain('logEvent("error", "request.error", fields)');
    expect(source.indexOf("logEvent(")).toBeLessThan(source.indexOf("reportRequestError("));
    expect(source).toContain("if (monitoring)");
  });

  it("the business frame sets the browser's identity; no public customer page does", () => {
    expect(read("src/app/o/[orgId]/layout.tsx")).toContain("<MonitoringIdentity userId={user.id} orgId={org.id} />");
    expect(isCustomerPagePath("/f")).toBe(true);
    expect(isCustomerPagePath("/f/book/x")).toBe(true);
    expect(isCustomerPagePath("/features")).toBe(false);
    expect(isCustomerPagePath("/o/x")).toBe(false);
  });
});

describe("OPS-05 CSP and build", () => {
  it("derives only the DSN's own sentry.io host", () => {
    expect(sentryIngestOrigin(DSN)).toBe("https://o4512453548965888.ingest.de.sentry.io");
    expect(sentryIngestOrigin("")).toBeNull();
    expect(sentryIngestOrigin(undefined)).toBeNull();
    expect(sentryIngestOrigin("http://key@o1.ingest.de.sentry.io/1")).toBeNull();
    expect(sentryIngestOrigin("https://key@evil.example.com/1")).toBeNull();
    expect(sentryIngestOrigin("https://key@sentry.io.evil.com/1")).toBeNull();
    expect(sentryIngestOrigin("https://key@o1.ingest.de.sentry.io:8443/1")).toBeNull();
    expect(sentryIngestOrigin("not a url")).toBeNull();
  });

  it("adds the host to connect-src only when given, never a wildcard", () => {
    const base = { nonce: "n", supabaseUrl: "https://ref.supabase.co", isDev: false, publicForm: false };
    const without = contentSecurityPolicy(base);
    expect(without).not.toContain("sentry");
    const withHost = contentSecurityPolicy({ ...base, sentryOrigin: "https://o4512453548965888.ingest.de.sentry.io" });
    const connect = withHost.split("; ").find((d) => d.startsWith("connect-src"))!;
    expect(connect).toContain("https://o4512453548965888.ingest.de.sentry.io");
    expect(withHost.split("; ").filter((d) => d.includes("sentry"))).toEqual([connect]);
    expect(withHost).not.toContain("*.sentry.io");
    // a value that is not one sentry.io host is ignored
    expect(contentSecurityPolicy({ ...base, sentryOrigin: "https://*.sentry.io" })).not.toContain("sentry");
    expect(contentSecurityPolicy({ ...base, sentryOrigin: "https://evil.example.com" })).not.toContain("evil");
  });

  it("the proxy gives the host only where Sentry may load (never /f/)", () => {
    const proxy = read("src/lib/supabase/proxy.ts");
    expect(proxy).toMatch(/sentryConfigured\(dsn, process\.env\.VERCEL_ENV\) \|\| isCustomerPagePath\(pathname\)/);
  });

  it("source maps upload only with all three Sentry build variables", () => {
    expect(sourceMapUploadReady({})).toBe(false);
    expect(sourceMapUploadReady({ SENTRY_AUTH_TOKEN: "t", SENTRY_ORG: "mexuz" })).toBe(false);
    expect(sourceMapUploadReady({ SENTRY_AUTH_TOKEN: " ", SENTRY_ORG: "mexuz", SENTRY_PROJECT: "mexuz" })).toBe(false);
    expect(sourceMapUploadReady({ SENTRY_AUTH_TOKEN: "t", SENTRY_ORG: "mexuz", SENTRY_PROJECT: "mexuz" })).toBe(true);
  });

  it(".env.example names every Sentry variable with an empty value", () => {
    const example = read(".env.example");
    for (const name of ["NEXT_PUBLIC_SENTRY_DSN", "SENTRY_DSN", "SENTRY_ACTIVE_FROM", "NEXT_PUBLIC_SENTRY_ACTIVE_FROM", "SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_AUTH_TOKEN"]) {
      expect(example).toMatch(new RegExp(`^${name}=$`, "m"));
    }
  });
});

describe("OPS-05 database errors and long text (owner (436) א)", () => {
  // what supabase-js returns for a failed call: a plain object (or a PostgrestError) with message, details, hint and code
  const POSTGREST = {
    message: "new row for relation \"leads\" violates check constraint: value דני כהן",
    details: "Failing row contains (dana@example.com, 0501234567, secret note).",
    hint: "limit:max_leads",
    code: "P0001",
  };

  it("reads a database error as its SQLSTATE and a code-like hint only", () => {
    expect(databaseErrorSummary(POSTGREST)).toBe("SQLSTATE P0001 hint limit:max_leads");
    expect(databaseErrorSummary({ ...POSTGREST, hint: "No function matches the given name and argument types." })).toBe("SQLSTATE P0001");
    expect(databaseErrorSummary({ ...POSTGREST, hint: null, code: "23505" })).toBe("SQLSTATE 23505");
    expect(databaseErrorSummary({ message: "JSON object requested, multiple rows", details: null, hint: null, code: "PGRST116" })).toBe(
      "PostgREST PGRST116",
    );
    const read = new DbReadError("leads list", { message: "Key (email)=(dana@example.com) exists", code: "57014", hint: "quote:frozen" });
    expect(databaseErrorSummary(read)).toBe("SQLSTATE 57014 hint quote:frozen");
    // not database errors: a Node system error (EPIPE has 5 capitals but no PostgREST shape), no code, a malformed code
    expect(databaseErrorSummary(Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" }))).toBeNull();
    expect(databaseErrorSummary(new Error("boom"))).toBeNull();
    expect(databaseErrorSummary({ code: "p0001", hint: null })).toBeNull();
    expect(databaseErrorSummary("P0001")).toBeNull();
  });

  it("sends a captured PostgREST object as code and hint only, nothing of message, details, where or query", () => {
    // Sentry's own shape for a plain object: the message in the value, the whole object in extra.__serialized__
    const event: MonitorEvent = {
      exception: {
        values: [
          {
            type: "Error",
            value: `Object captured as exception with message '${POSTGREST.message}'`,
            stacktrace: { frames: [{ filename: "app:///_next/server/chunks/ssr/abc123def456ghi789.js" }] },
            mechanism: { type: "generic", handled: true, synthetic: true, data: { details: POSTGREST.details } },
            ...({ details: POSTGREST.details, where: "PL/pgSQL function app.x() line 3", query: "select 1" } as object),
          },
        ],
      },
      extra: { __serialized__: POSTGREST },
      contexts: { os: { name: "linux" }, postgres: { details: POSTGREST.details, where: "w", query: "q" } },
    };
    const out = scrubEvent(event, { ...OPEN, original: POSTGREST })!;
    const value = out.exception!.values![0];
    expect(value.value).toBe("SQLSTATE P0001 hint limit:max_leads");
    expect(value.stacktrace!.frames).toHaveLength(1);
    expect(value.mechanism).toEqual({ type: "generic", handled: true, synthetic: true });
    expect(Object.keys(value).sort()).toEqual(["mechanism", "stacktrace", "type", "value"]);
    const text = JSON.stringify(out);
    for (const leak of ["Failing row", "dana@example.com", "0501234567", "violates", "PL/pgSQL", "select 1", "where", "query"]) {
      expect(text).not.toContain(leak);
    }
    expect(out.contexts).toEqual({ os: { name: "linux" } });
  });

  it("sends a thrown DbReadError as code and hint, and keeps its stack", () => {
    const error = new DbReadError("deal_lines", { message: "permission denied for table leads: דני", code: "42501", hint: null });
    const frames = [{ filename: "/var/task/.next/server/chunks/ssr/abc123def456ghi789.js", function: "must" }];
    const out = scrubEvent(
      { exception: { values: [{ type: "DbReadError", value: error.message, stacktrace: { frames } }] } },
      { ...OPEN, original: error },
    )!;
    expect(out.exception!.values![0].value).toBe("SQLSTATE 42501");
    expect(out.exception!.values![0].stacktrace!.frames![0]).toMatchObject({ function: "must" });
  });

  it("replaces a database error that is the cause of another error, matched by its type", () => {
    const cause = Object.assign(new Error("deadlock detected DETAIL: Process 12 waits for row (7, dana)"), {
      name: "PostgrestError",
      code: "40P01",
      details: "Process 12 waits for ShareLock",
      hint: "See server log for query details.",
    });
    const outer = new Error("save failed", { cause });
    const out = scrubEvent(
      {
        exception: {
          values: [
            { type: "PostgrestError", value: cause.message, mechanism: { type: "chained", source: "cause", exception_id: 1, parent_id: 0 } },
            { type: "Error", value: "save failed", mechanism: { type: "generic", exception_id: 0 } },
          ],
        },
      },
      { ...OPEN, original: outer },
    )!;
    expect(out.exception!.values![0].value).toBe("SQLSTATE 40P01");
    expect(out.exception!.values![1].value).toBe("save failed");
  });

  it("never sends a database error's own text even when the original is not known", () => {
    const out = scrubEvent(
      {
        exception: {
          values: [
            { type: "DbReadError", value: "database read failed: leads: 23505 duplicate key Key (email)=(x@y.z)" },
            { type: "PostgrestError", value: "permission denied" },
          ],
        },
      },
      OPEN,
    )!;
    expect(out.exception!.values!.map((v) => v.value)).toEqual(["database error", "database error"]);
  });

  it("cuts Postgres report tails (HINT, CONTEXT, WHERE, QUERY, STATEMENT, LINE n) out of any text", () => {
    expect(sentryText("function failed HINT: check the row of dana")).toBe("function failed");
    expect(sentryText("raise CONTEXT: PL/pgSQL function app.x() line 3 at RAISE")).toBe("raise");
    expect(sentryText("syntax error WHERE: SQL statement \"select secret\"")).toBe("syntax error");
    expect(sentryText("bad QUERY: select * from leads")).toBe("bad");
    expect(sentryText("bad STATEMENT: update leads set x")).toBe("bad");
    expect(sentryText("syntax error at or near x LINE 1: select x")).toBe("syntax error at or near x");
  });

  it("cuts every free text to 200 characters after the scrubbing", () => {
    expect(SENTRY_TEXT_MAX).toBe(200);
    const long = `failed ${"at step ".repeat(60)}`;
    expect(sentryText(long)).toHaveLength(200);
    // the redaction runs first, so an address near the end is replaced, not cut in half
    const out = scrubEvent(
      {
        message: long,
        logentry: { message: long },
        exception: { values: [{ type: "Error", value: `${"go on ".repeat(31)} dana@example.com and more` }] },
      },
      OPEN,
    )!;
    expect(out.message).toHaveLength(200);
    expect(out.logentry!.message).toHaveLength(200);
    expect(out.exception!.values![0].value!.length).toBeLessThanOrEqual(200);
    expect(out.exception!.values![0].value).not.toContain("dana");
    // never half of a surrogate pair
    const emoji = `${"x y ".repeat(49)}abc\u{1F600}tail`;
    const cut = sentryText(emoji);
    expect(cut).toBe(`${"x y ".repeat(49)}abc`);
  });

  it("both runtimes hand the captured error to the rules", () => {
    expect(read("src/lib/monitoring/sentry-server.ts")).toContain("original: hint?.originalException");
    expect(read("src/lib/monitoring/sentry-client.ts")).toContain("original: hint?.originalException");
  });
});

describe("OPS-05 length cap on every free-text field (review)", () => {
  it("caps the transaction, the request url, the exception type and module at 200 after scrubbing", () => {
    const longPath = `/o/${"segment/".repeat(60)}end`;
    const out = scrubEvent(
      {
        transaction: longPath,
        request: { url: `https://mexuzsystem.com${longPath}?q=dana@example.com`, method: "GET" },
        exception: { values: [{ type: `Error${"X".repeat(300)}`, value: "boom", ...({ module: longPath } as object) }] },
      },
      OPEN,
    )!;
    expect(out.transaction!.length).toBeLessThanOrEqual(200);
    expect(out.request!.url!.length).toBeLessThanOrEqual(200);
    expect(out.request!.url).not.toContain("dana");
    expect(out.exception!.values![0].type!.length).toBeLessThanOrEqual(200);
    expect((out.exception!.values![0] as { module?: string }).module!.length).toBeLessThanOrEqual(200);
  });
});

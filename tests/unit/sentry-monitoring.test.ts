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
  scrubEvent,
  scrubUrl,
  sentryConfigured,
  sentryIngestOrigin,
  sentryOpen,
  type MonitorEvent,
} from "@/lib/monitoring/sentry-rules";
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
    const names = ["Breadcrumbs", "BrowserTracing", "BrowserSession", "Replay", "Feedback", "Http", "RequestData", "LocalVariables", "Console", "GlobalHandlers", "LinkedErrors", "Dedupe"];
    expect(keptIntegrations(names.map((name) => ({ name }))).map((i) => i.name)).toEqual(["GlobalHandlers", "LinkedErrors", "Dedupe"]);
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

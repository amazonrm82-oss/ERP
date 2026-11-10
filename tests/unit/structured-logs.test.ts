import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logEvent, LOG_FIELDS, logRecord, redactText } from "@/lib/log";
import { REQUEST_ID_HEADER, requestIdFor, requestIdOf } from "@/lib/request-id";

// OPS-06: structured logs. One JSON line per event with a request id (and the business when known), a closed list of
// field names, values judged by kind, no secrets and no message content; and console.* only inside the logger.

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));

const ORG = "11111111-1111-4111-8111-111111111111";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.c2lnbmF0dXJlLXZhbHVl";
const strip = (r: Record<string, unknown>) => {
  const rest = { ...r };
  delete rest.time;
  return rest;
};

describe("OPS-06: a log line", () => {
  it("has time, level, event and request_id, and only fields from the closed list", () => {
    const fields = { org_id: ORG, code: "P0001", body: "the whole request", email: "dana@example.com", cookie: "sb=x", token: JWT } as never;
    const r = logRecord("error", "intake.submit_failed", fields, new Date("2026-11-10T08:00:00Z"));
    expect(r).toEqual({ time: "2026-11-10T08:00:00.000Z", level: "error", event: "intake.submit_failed", request_id: null, org_id: ORG, code: "P0001" });
    expect(Object.keys(LOG_FIELDS)).not.toEqual(expect.arrayContaining(["body"]));
    for (const name of ["body", "email", "phone", "message", "text", "payload", "cookie", "token", "headers", "name"]) {
      expect(LOG_FIELDS, name).not.toHaveProperty(name);
    }
  });

  it("drops a value that does not have its field's shape", () => {
    const r = strip(
      logRecord("warn", "x", { org_id: "not-a-uuid", job_id: "dana@example.com", request_id: "id with spaces", code: "a b", count: Number.NaN, busy: "yes" as never }),
    );
    expect(r).toEqual({ level: "warn", event: "x", request_id: null });
    expect(logRecord("info", "Bad Event!").event).toBe("invalid_event");
  });

  it("redacts free text: tokens, quoted runs, emails and phone numbers", () => {
    const text = redactText(`failed for dana.cohen@example.co.il at 050-123-4567 / +972501234567 with ${JWT} "secret value"`);
    expect(text).not.toMatch(/dana|example|4567|eyJ|secret/);
    expect(text).toContain("[email]");
    expect(text).toContain("[number]");
    expect(redactText("fetch failed: ECONNRESET")).toBe("fetch failed: ECONNRESET");
    expect(redactText("a\nforged line")).toBe("a forged line");
    expect(redactText("x".repeat(1000)).length).toBeLessThanOrEqual(300);
  });

  it("cleans a path: no query, no fragment, the token of a public link hidden", () => {
    const t = "0123456789abcdef0123456789abcdef";
    const r = logRecord("error", "x", { path: `/f/quote/${t}?email=dana@example.com#x` });
    expect(r.path).toBe("/f/quote/[token]");
    expect(logRecord("error", "x", { object_path: `${ORG}/${ORG}` }).object_path).toBe(`${ORG}/${ORG}`);
    expect(logRecord("error", "x", { object_path: "../etc/passwd" })).not.toHaveProperty("object_path");
  });

  it("keeps plain server text, after the same email, number and secret redaction, with only its safe characters", () => {
    expect(
      logRecord("error", "x", { details: "totals.deals_with_document_discount[0]: invalid_type; dana.cohen@example.com 0501234567" }).details,
    ).toBe("totals.deals_with_document_discount[0]: invalid_type; [email] [number]");
    expect(logRecord("error", "x", { details: `failed: Bearer abc token=xyz ${JWT} aGVsbG8gd29ybGQgMTIzNDU2` }).details).toBe(
      "failed: Bearer [redacted] token=[redacted] [redacted] [redacted]",
    );
  });

  it("redacts credentials after Bearer/Basic and key=value secrets, and base64-style runs with a digit, + or /", () => {
    const text = redactText("auth Bearer ab Basic Zm9v:bar key=1 secret=s password=p&x=1 run QUJDREVGR0hJSktMTU5PUA+/ ok");
    expect(text).toBe("auth Bearer [redacted] Basic [redacted] key=[redacted] secret=[redacted] password=[redacted]&x=1 run [redacted] ok");
    // a long plain word is redacted only in outside text (redactLogText), never because of this rule
    expect(redactText("2026-11-10T08:00:00Z on 2026-11-10 call 050-123-4567")).toBe("2026-11-10T08:00:00Z on 2026-11-10 call [number]");
  });

  it("refuses JWT-shaped and over-long codes, and keeps route groups in a route", () => {
    const token = "abcdefghijklmnop1234.qrstuvwxyzABCDEF5678";
    expect(logRecord("error", "x", { code: token })).not.toHaveProperty("code");
    expect(logRecord("error", "x", { reason: "a".repeat(65) })).not.toHaveProperty("reason");
    expect(logRecord("error", "x", { reason: "a".repeat(64) }).reason).toBe("a".repeat(64));
    expect(logRecord("error", "x", { route: "/(auth)/login" }).route).toBe("/(auth)/login");
    expect(logRecord("error", "x", { route: "/o/[orgId]/@modal/(.)leads/[id]" }).route).toBe("/o/[orgId]/@modal/(.)leads/[id]");
    expect(logRecord("error", "x", { route: `/x/${token}` })).not.toHaveProperty("route");
  });

  it("cleans a path: escapes decoded, slashes collapsed, any case of a public prefix, emails and token segments", () => {
    const t = "0123456789abcdef0123456789abcdef";
    expect(logRecord("error", "x", { path: "/o/abc/contacts/dana%40example.com" }).path).toBe("/o/abc/contacts/[email]");
    expect(logRecord("error", "x", { path: `//F/Quote/${t}` }).path).toBe("/f/quote/[token]");
    expect(logRecord("error", "x", { path: `/f%2Fquote/${t}` }).path).toBe("/f/quote/[token]");
    expect(logRecord("error", "x", { path: `/o/${ORG}/files/${ORG}` }).path).toBe(`/o/${ORG}/files/${ORG}`);
    expect(logRecord("error", "x", { path: "/o/abc/reset/Zq9_-0123456789abcdefXYZ" }).path).toBe("/o/abc/reset/[redacted]");
    expect(logRecord("error", "x", { path: "/o/abc/settings/message-templates" }).path).toBe("/o/abc/settings/message-templates");
  });

  it("writes one JSON line: errors to stderr, info to stdout; never throws", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("error", "a.b", { code: "x" });
    logEvent("info", "c.d");
    expect(err).toHaveBeenCalledTimes(1);
    expect(out).toHaveBeenCalledTimes(1);
    const line = String(err.mock.calls[0][0]);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toMatchObject({ level: "error", event: "a.b", code: "x" });
    err.mockRestore();
    out.mockRestore();
  });
});

describe("OPS-06: the request id", () => {
  it("is Vercel's x-vercel-id when it has a sane shape, else a fresh random one", () => {
    expect(requestIdFor(new Headers({ "x-vercel-id": "fra1::iad1::abc12-1700000000000-0123456789ab" }))).toBe("fra1::iad1::abc12-1700000000000-0123456789ab");
    expect(requestIdFor(new Headers({ "x-vercel-id": "<script>" }))).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdFor(new Headers())).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdOf(new Headers({ [REQUEST_ID_HEADER]: "abc-1" }))).toBe("abc-1");
    expect(requestIdOf(new Headers({ [REQUEST_ID_HEADER]: "bad value\n" }))).toBeNull();
    // Vercel's own id wins over a header a visitor could send on a path the proxy does not match
    expect(requestIdOf(new Headers({ [REQUEST_ID_HEADER]: "forged", "x-vercel-id": "fra1::real-1" }))).toBe("fra1::real-1");
  });

  describe("through the proxy", () => {
    const saved = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
    beforeEach(() => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    });
    afterEach(() => {
      if (saved.url !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.key;
    });

    it("sets x-crm-request-id on the request, overwriting a visitor's own", async () => {
      const { updateSession } = await import("@/lib/supabase/proxy");
      const forged = new NextRequest(new URL("/login", "https://crm.example.test"), { headers: { [REQUEST_ID_HEADER]: "forged-by-visitor" } });
      const response = await updateSession(forged);
      const set = response.headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`);
      expect(set).toMatch(/^[0-9a-f-]{36}$/);
      const vercel = new NextRequest(new URL("/login", "https://crm.example.test"), { headers: { "x-vercel-id": "fra1::xyz-1" } });
      expect((await updateSession(vercel)).headers.get(`x-middleware-request-${REQUEST_ID_HEADER}`)).toBe("fra1::xyz-1");
    });
  });

  it("reaches a line written inside a request (serverLog)", async () => {
    const { serverLog } = await import("@/lib/log-server");
    requestHeaders = new Headers({ [REQUEST_ID_HEADER]: "req-42" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await serverLog("error", "intake.submit_failed", { org_id: ORG, code: "P0001" });
    expect(JSON.parse(String(err.mock.calls[0][0]))).toMatchObject({ request_id: "req-42", org_id: ORG, code: "P0001" });
    err.mockRestore();
  });
});

describe("OPS-06: server code logs only through the logger", () => {
  it("no console (or process.stdout/stderr) in a server file outside src/lib/log.ts; eslint no-console says the same", () => {
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) {
          const rel = relative(root, path).replaceAll("\\", "/");
          if (rel === "lib/log.ts") continue;
          const source = readFileSync(path, "utf8");
          // browser code may write to the browser's console
          if (/^\s*["']use client["']/.test(source)) continue;
          if (/\bconsole\b/.test(source) || /\bprocess\s*\.\s*std(out|err)\b/.test(source)) offenders.push(rel);
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mfaSessionCheck } from "@/features/auth/mfa-session";
import { logSessionCheckThrow } from "@/lib/auth-transient";

// FXC-10 security review follow-ups: the second-step screen keeps the session on an outage, and a session check that
// throws is logged on the server (tag, error name and message; never a cookie or a token).

const SECRET = "eyJhbGciOiJIUzI1NiJ9.SECRET-TOKEN-VALUE";

type AuthAnswer = { error: unknown } | { throws: unknown };
let answer: AuthAnswer = { error: null };
const respond = async (data: unknown) => {
  if ("throws" in answer) throw answer.throws;
  return { data: answer.error ? { user: null, claims: null } : data, error: answer.error };
};
const fakeAuth = {
  getUser: () => respond({ user: { id: "u1" } }),
  getClaims: () => respond({ claims: { sub: "u1", email: null, user_metadata: {} } }),
};

vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: fakeAuth }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: fakeAuth }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [{ name: "sb-x-auth-token", value: SECRET }] }),
  headers: async () => new Headers(),
}));

describe("the second-step screen's session check", () => {
  it("an outage keeps the session; an answer about the session signs out; a user goes on", () => {
    expect(mfaSessionCheck(new AuthRetryableFetchError("fetch failed", 0), false)).toBe("unavailable");
    expect(mfaSessionCheck(new AuthRetryableFetchError("Service Unavailable", 503), false)).toBe("unavailable");
    expect(mfaSessionCheck(new AuthApiError("rate limit", 429, "over_request_rate_limit"), false)).toBe("unavailable");
    expect(mfaSessionCheck(new AuthApiError("Session not found", 403, "session_not_found"), false)).toBe("signed_out");
    expect(mfaSessionCheck(new AuthSessionMissingError(), false)).toBe("signed_out");
    expect(mfaSessionCheck(null, false)).toBe("signed_out");
    expect(mfaSessionCheck(null, true)).toBe("ok");
  });
});

describe("a session check that throws is logged, without cookies or tokens", () => {
  let logged: string[];
  beforeEach(() => {
    vi.resetModules();
    logged = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("the helper writes the tag, the error's name and message", () => {
    logSessionCheckThrow("proxy", new TypeError("boom"));
    logSessionCheckThrow("readSession", "not an error");
    expect(logged).toEqual([
      "[auth:proxy] session check threw; treated as unavailable: TypeError: boom",
      "[auth:readSession] session check threw; treated as unavailable: string",
    ]);
  });

  it("readSession logs a throw once, and still answers 'unavailable'", async () => {
    answer = { throws: new TypeError("Cannot read properties of undefined") };
    const { sessionCheck } = await import("@/lib/auth");
    expect(await sessionCheck()).toMatchObject({ ok: false, unavailable: true });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("[auth:readSession]");
    expect(logged[0]).toContain("TypeError: Cannot read properties of undefined");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("the proxy logs a throw once, lets the request on, and logs no cookie", async () => {
    answer = { throws: new TypeError("fetch failed") };
    const { updateSession } = await import("@/lib/supabase/proxy");
    const request = new NextRequest(new URL("/o/11111111-1111-4111-8111-111111111111/leads", "https://crm.example.test"), {
      headers: { cookie: `sb-x-auth-token=${SECRET}` },
    });
    const response = await updateSession(request);
    expect(response.headers.get("location")).toBeNull();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("[auth:proxy]");
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("an error the auth client answers with (not thrown) is not logged as a throw", async () => {
    answer = { error: new AuthRetryableFetchError("Service Unavailable", 503) };
    const { sessionCheck } = await import("@/lib/auth");
    expect(await sessionCheck()).toMatchObject({ ok: false, unavailable: true });
    const { updateSession } = await import("@/lib/supabase/proxy");
    await updateSession(new NextRequest(new URL("/o/11111111-1111-4111-8111-111111111111/leads", "https://crm.example.test")));
    expect(logged).toEqual([]);
  });
});

import { AuthApiError, AuthInvalidJwtError, AuthRetryableFetchError, AuthSessionMissingError, AuthUnknownError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { isTransientAuthError } from "@/lib/auth-transient";
import { AUTH_UNAVAILABLE_DIGEST, AUTH_UNAVAILABLE_MESSAGE, AuthUnavailableError, isAuthUnavailableDigest } from "@/lib/auth-unavailable";
import { SESSION_EXPIRED } from "@/lib/errors";

// FXC-10: a passing failure of the sign-in service is not a signed-out user.

type AuthAnswer = { error: unknown; data?: unknown } | { throws: unknown };
let answer: AuthAnswer = { error: null };
const respond = async (data: unknown) => {
  if ("throws" in answer) throw answer.throws;
  return { data: answer.error ? { user: null, claims: null } : data, error: answer.error };
};
const fakeAuth = {
  getUser: () => respond({ user: { id: "u1" } }),
  getClaims: () => respond({ claims: { sub: "u1", email: "dana@example.test", user_metadata: { full_name: "דנה" } } }),
};

vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: fakeAuth }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: fakeAuth }) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

const NETWORK = new AuthRetryableFetchError("fetch failed", 0);
const DOWN = new AuthRetryableFetchError("Service Unavailable", 503);
const UNREADABLE = new AuthUnknownError("Unexpected token <", new Error("parse"));
const RATE_LIMIT = new AuthApiError("Request rate limit reached", 429, "over_request_rate_limit");
const SIGNED_OUT = new AuthApiError("Session from session_id claim in JWT does not exist", 403, "session_not_found");
const BAD_JWT = new AuthInvalidJwtError("Invalid JWT signature");
const NO_SESSION = new AuthSessionMissingError();

describe("which failures are a passing problem (FXC-10)", () => {
  it("network, 5xx, unreadable replies, rate limits and anything thrown are transient", () => {
    for (const error of [NETWORK, DOWN, UNREADABLE, RATE_LIMIT, new TypeError("fetch failed")]) {
      expect(isTransientAuthError(error), String(error)).toBe(true);
    }
  });

  it("an answer about the session is not", () => {
    for (const error of [SIGNED_OUT, BAD_JWT, NO_SESSION, new AuthApiError("User not found", 404, "user_not_found")]) {
      expect(isTransientAuthError(error), String(error)).toBe(false);
    }
  });

  it("the page error carries its own digest, which the error screen recognizes", () => {
    const error = new AuthUnavailableError();
    expect(error.digest).toBe(AUTH_UNAVAILABLE_DIGEST);
    expect(isAuthUnavailableDigest(error.digest)).toBe(true);
    expect(isAuthUnavailableDigest("12345")).toBe(false);
    expect(isAuthUnavailableDigest(undefined)).toBe(false);
  });
});

describe("the proxy does not send anyone to the login page for a passing failure (FXC-10)", () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  });

  const visit = async (path: string) => {
    const { updateSession } = await import("@/lib/supabase/proxy");
    return updateSession(new NextRequest(new URL(path, "https://crm.example.test")));
  };
  const location = (response: Response) => response.headers.get("location");

  it("a page of the app passes on when the auth server does not answer, or throws", async () => {
    for (const next of [{ error: NETWORK }, { error: DOWN }, { error: RATE_LIMIT }, { throws: new TypeError("fetch failed") }] as AuthAnswer[]) {
      answer = next;
      const response = await visit("/o/11111111-1111-4111-8111-111111111111/leads");
      expect(location(response), JSON.stringify(next)).toBeNull();
    }
  });

  it("a signed-out or missing session still goes to the login page", async () => {
    for (const next of [{ error: SIGNED_OUT }, { error: BAD_JWT }, { error: NO_SESSION }] as AuthAnswer[]) {
      answer = next;
      const response = await visit("/o/11111111-1111-4111-8111-111111111111/leads");
      expect(new URL(location(response)!).pathname).toBe("/login");
    }
  });

  it("a signed-in visitor of the login page still goes on into the app, but not on a passing failure", async () => {
    answer = { error: null };
    expect(location(await visit("/login?next=/app"))).toBe("https://crm.example.test/app");
    answer = { error: DOWN };
    expect(location(await visit("/login"))).toBeNull();
  });
});

describe("pages and actions read the session in three ways (FXC-10)", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  });

  it("a signed-in user", async () => {
    answer = { error: null };
    const { getSessionUser, sessionCheck } = await import("@/lib/auth");
    expect(await getSessionUser()).toEqual({ id: "u1", email: "dana@example.test", fullName: "דנה" });
    expect(await sessionCheck()).toEqual({ ok: true, user: { id: "u1", email: "dana@example.test", fullName: "דנה" } });
  });

  it("signed out: null for pages, 'session expired' for actions", async () => {
    answer = { error: SIGNED_OUT };
    const { getSessionUser, sessionCheck } = await import("@/lib/auth");
    expect(await getSessionUser()).toBeNull();
    expect(await sessionCheck()).toEqual({ ok: false, message: SESSION_EXPIRED, unavailable: false });
  });

  it("the auth server did not answer: pages throw the recognizable error, actions answer 'communication problem'", async () => {
    for (const next of [{ error: NETWORK }, { throws: new TypeError("fetch failed") }] as AuthAnswer[]) {
      answer = next;
      vi.resetModules();
      const { getSessionUser, sessionCheck } = await import("@/lib/auth");
      // modules were reloaded, so compare by the digest the error screen reads, not by class
      await expect(getSessionUser()).rejects.toMatchObject({ digest: AUTH_UNAVAILABLE_DIGEST });
      expect(await sessionCheck()).toEqual({ ok: false, message: AUTH_UNAVAILABLE_MESSAGE, unavailable: true });
    }
  });

  it("an org-scoped action answers 'communication problem' and does not drop the user", async () => {
    answer = { error: DOWN };
    const { actionContext } = await import("@/lib/action-context");
    expect(await actionContext("11111111-1111-4111-8111-111111111111")).toEqual({ ok: false, message: AUTH_UNAVAILABLE_MESSAGE });
  });
});

import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// USR-13 (owner, 13 November 2026, answers (364) א and (370) א): the sign-in action asks the lockout before Auth, answers a
// locked address with EXACTLY the wrong-password message without calling Auth, counts only Auth's "wrong address or
// password" answer, and sends the database only keyed hashes.

const rpc = vi.fn();
const signIn = vi.fn();
let requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.7" });

vi.mock("next/headers", () => ({ headers: async () => requestHeaders, cookies: async () => ({ getAll: () => [] }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/supabase/service", () => ({ createServiceClient: () => ({ rpc }) }));
vi.mock("@/lib/supabase/auth-forwarding-server", () => ({
  forwardedSignIn: (...args: unknown[]) => signIn(...args),
  forwardedSignUp: vi.fn(),
  forwardedResetPassword: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: {} }) }));
vi.mock("@/features/auth/turnstile-server", () => ({
  verifyTurnstile: async () => ({ ok: true }),
  verifyTurnstileToken: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth", () => ({ owesSecondStep: async () => false, sessionCheck: async () => ({ ok: true }) }));
vi.mock("@/lib/log-server", () => ({ serverLog: async () => undefined }));

const SECRET = "test-secret-for-login-lockout";
const WINDOW = "2026-11-13T09:00:00.123456+00:00";
const OPEN = { locked: false, email_window: WINDOW, ip_window: WINDOW };
const WRONG = "האימייל או הסיסמה שגויים. בדקו ונסו שוב, או לחצו על \"שכחתי סיסמה\".";

function form(email: string, password = "secret-password-1") {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

async function signInAction(email = "Dana@Example.co ") {
  const { signInAction: action } = await import("@/features/auth/actions");
  try {
    return await action({ ok: false, message: "" } as never, form(email));
  } catch (error) {
    return { redirected: (error as Error).message };
  }
}

const events = () => rpc.mock.calls.map((call) => (call[1] as { p_event: string }).p_event);

beforeEach(() => {
  rpc.mockReset();
  signIn.mockReset();
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.7" });
  process.env.INTAKE_IP_HASH_SECRET = SECRET;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  rpc.mockResolvedValue({ data: OPEN, error: null });
});
afterEach(() => {
  delete process.env.INTAKE_IP_HASH_SECRET;
});

describe("sign-in lockout (USR-13)", () => {
  it("a locked address gets exactly the wrong-password answer and Auth is never asked", async () => {
    rpc.mockResolvedValue({ data: { locked: true }, error: null });
    const locked = await signInAction();
    expect(signIn).not.toHaveBeenCalled();
    expect(events()).toEqual(["attempt"]);

    rpc.mockResolvedValue({ data: OPEN, error: null });
    signIn.mockResolvedValue({ error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") });
    const wrong = await signInAction();
    expect(locked).toEqual(wrong);
    expect((wrong as { message: string }).message).toBe(WRONG);
  });

  it("a wrong password keeps its reserved try; a success clears the address", async () => {
    signIn.mockResolvedValue({ error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") });
    await signInAction();
    expect(events()).toEqual(["attempt"]);

    rpc.mockClear();
    signIn.mockResolvedValue({ error: null });
    expect(await signInAction()).toEqual({ redirected: "REDIRECT:/" });
    expect(events()).toEqual(["attempt", "success"]);
  });

  it("the outcome hands back the windows the attempt answered, and nothing when nothing was reserved", async () => {
    signIn.mockResolvedValue({ error: null });
    await signInAction();
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_event: "success", p_email_window: WINDOW, p_ip_window: WINDOW });
    rpc.mockClear();
    rpc.mockResolvedValueOnce({ data: { locked: false }, error: null });
    signIn.mockResolvedValue({ error: new AuthRetryableFetchError("fetch failed", 0) });
    await signInAction();
    expect(events()).toEqual(["attempt"]);
  });

  it("an older Auth answer without a code still counts and gets the same message", async () => {
    signIn.mockResolvedValue({ error: { status: 400, message: "Invalid login credentials" } });
    const answer = await signInAction();
    expect(events()).toEqual(["attempt"]);
    expect((answer as { message: string }).message).toBe(WRONG);
  });

  it("network errors, 5xx, rate limits and an unconfirmed address give the reserved try back", async () => {
    for (const error of [
      new AuthRetryableFetchError("fetch failed", 0),
      new AuthApiError("Service Unavailable", 503, undefined),
      new AuthApiError("rate limit", 429, "over_request_rate_limit"),
      new AuthApiError("Email not confirmed", 400, "email_not_confirmed"),
    ]) {
      rpc.mockClear();
      signIn.mockResolvedValue({ error });
      await signInAction();
      expect(events()).toEqual(["attempt", "release"]);
    }
    // a throw from the Auth call gives it back too
    rpc.mockClear();
    signIn.mockRejectedValue(new Error("boom"));
    expect(await signInAction()).toEqual({ redirected: "boom" });
    expect(events()).toEqual(["attempt", "release"]);
  });

  it("sends only keyed hashes: the trimmed lower-case address (scope login-email) and the sender (scope login)", async () => {
    signIn.mockResolvedValue({ error: new AuthApiError("Invalid login credentials", 400, "invalid_credentials") });
    await signInAction("  Dana@Example.co ");
    const hmac = (value: string) => createHmac("sha256", SECRET).update(value).digest("hex");
    const args = rpc.mock.calls[0][1] as Record<string, string>;
    expect(rpc.mock.calls[0][0]).toBe("login_guard");
    expect(args).toEqual({ p_email_hash: hmac("login-email:dana@example.co"), p_ip_hash: hmac("login:203.0.113.7"), p_event: "attempt", p_email_window: null, p_ip_window: null });
    const sent = JSON.stringify(rpc.mock.calls);
    expect(sent).not.toMatch(/dana|example|203\.0\.113|secret-password/i);
  });

  it("an IPv6 sender is counted by its /64", async () => {
    requestHeaders = new Headers({ "x-forwarded-for": "2001:db8:0:1:aaaa::1" });
    signIn.mockResolvedValue({ error: null });
    await signInAction();
    const other = (rpc.mock.calls[0][1] as Record<string, string>).p_ip_hash;
    rpc.mockClear();
    requestHeaders = new Headers({ "x-forwarded-for": "2001:db8:0:1:bbbb::2" });
    await signInAction();
    expect((rpc.mock.calls[0][1] as Record<string, string>).p_ip_hash).toBe(other);
  });

  it("fails open: no secret, or a database error, never blocks a sign-in", async () => {
    delete process.env.INTAKE_IP_HASH_SECRET;
    signIn.mockResolvedValue({ error: null });
    expect(await signInAction()).toEqual({ redirected: "REDIRECT:/" });
    expect(rpc).not.toHaveBeenCalled();

    process.env.INTAKE_IP_HASH_SECRET = SECRET;
    rpc.mockResolvedValue({ data: null, error: { code: "57014", message: "timeout" } });
    expect(await signInAction()).toEqual({ redirected: "REDIRECT:/" });
    rpc.mockRejectedValue(new Error("network"));
    expect(await signInAction()).toEqual({ redirected: "REDIRECT:/" });
  });

  it("forgot-password and sign-up do not use the lockout", () => {
    const code = readFileSync(join(__dirname, "..", "..", "src/features/auth/actions.ts"), "utf8");
    const signInBody = code.slice(code.indexOf("export async function signInAction"), code.indexOf("export async function forgotPasswordAction"));
    const rest = code.replace(signInBody, "");
    expect(rest).not.toMatch(/reserveLoginAttempt\(|recordLoginOutcome\(/);
    expect(signInBody.indexOf("verifyTurnstile(")).toBeLessThan(signInBody.indexOf("reserveLoginAttempt("));
    expect(signInBody.indexOf("reserveLoginAttempt(")).toBeLessThan(signInBody.indexOf("forwardedSignIn("));
  });

  it("only the guard file calls login_guard", () => {
    const guard = readFileSync(join(__dirname, "..", "..", "src/features/auth/login-guard-server.ts"), "utf8");
    expect([...guard.matchAll(/\.rpc\("([a-z_]+)"/g)].map((m) => m[1])).toEqual(["login_guard"]);
    expect(guard).not.toMatch(/\.from\(|\.auth\.|\.storage/);
  });
});

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// USR-10 (owner (389) ג): sign-in by a one-time link to the email. The action checks the fields, then Turnstile, then asks Auth
// through the FXS-12 forwarding client (owner (392) א; shouldCreateUser false is fixed there, tests/unit/auth-forwarding.test.ts);
// the page gets the same answer whether or not the address has an account; the link returns through /auth/callback with a
// same-site `next`; no address is ever logged. Owner (393) א: the reset email answers the same way for every outcome.

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}));

const logged: string[] = [];
const padAuthAnswer = vi.fn(async () => undefined);
const ADDRESS = "dana.cohen@example.co.il";

beforeEach(() => {
  vi.resetModules();
  logged.length = 0;
  padAuthAnswer.mockClear();
  for (const level of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  }
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.7" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/supabase/server");
  vi.doUnmock("@/lib/supabase/auth-forwarding-server");
  vi.doUnmock("@/features/auth/answer-floor");
});

async function withAuth(answer: { error: unknown } | (() => Promise<never>)) {
  const respond = typeof answer === "function" ? answer : async () => ({ data: {}, ...answer });
  const signInWithOtp = vi.fn();
  // the time floor is pinned on its own below; here it only must be awaited on every path
  vi.doMock("@/features/auth/answer-floor", () => ({ padAuthAnswer }));
  vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { signInWithOtp } }) }));
  const forwarded = {
    forwardedSignIn: vi.fn(),
    forwardedSignUp: vi.fn(),
    forwardedResetPassword: vi.fn(respond),
    forwardedMagicLink: vi.fn(respond),
  };
  vi.doMock("@/lib/supabase/auth-forwarding-server", () => forwarded);
  const actions = await import("@/features/auth/actions");
  return { actions, signInWithOtp, forwarded };
}

function form(email: string, next?: string) {
  const f = new FormData();
  f.set("email", email);
  if (next !== undefined) f.set("next", next);
  return f;
}

describe("the answer never tells whether the address has an account", () => {
  it("an existing and a missing address get the same page answer", async () => {
    const { MAGIC_LINK_SENT } = await import("@/features/auth/magic-link");
    const existing = await withAuth({ error: null });
    const a = await existing.actions.magicLinkAction(null, form(ADDRESS));
    vi.resetModules();
    const missing = await withAuth({ error: { status: 422, code: "otp_disabled", message: "Signups not allowed for otp" } });
    const b = await missing.actions.magicLinkAction(null, form("nobody@example.com"));
    expect(a).toEqual({ ok: true, message: MAGIC_LINK_SENT });
    expect(b).toEqual(a);
    expect(JSON.stringify(a)).not.toContain(ADDRESS);
  });

  it("every Auth outcome gets the same answer, after the time floor; a throw too", async () => {
    const { MAGIC_LINK_SENT } = await import("@/features/auth/magic-link");
    const outcomes = [
      { status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" },
      { status: 429, code: "over_email_send_rate_limit", message: "Email rate limit exceeded" },
      { status: 429, code: "over_email_send_rate_limit", message: "For security purposes, you can only request this after 42 seconds." },
      { status: 500, code: "unexpected_failure", message: "Error sending magic link email" },
      { status: 429, message: "Too many requests" },
    ];
    for (const error of outcomes) {
      vi.resetModules();
      padAuthAnswer.mockClear();
      const { actions } = await withAuth({ error });
      expect(await actions.magicLinkAction(null, form(ADDRESS))).toEqual({ ok: true, message: MAGIC_LINK_SENT });
      expect(padAuthAnswer).toHaveBeenCalledTimes(1);
    }
    vi.resetModules();
    padAuthAnswer.mockClear();
    const { actions } = await withAuth(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await actions.magicLinkAction(null, form(ADDRESS))).toEqual({ ok: true, message: MAGIC_LINK_SENT });
    expect(padAuthAnswer).toHaveBeenCalledTimes(1);
  });
});

describe("owner (393) א: the reset email answers the same for every outcome", () => {
  const SENT = `אם יש חשבון עם הכתובת ${ADDRESS}, שלחנו אליה קישור לבחירת סיסמה חדשה.`;
  const outcomes: Array<{ error: unknown } | (() => Promise<never>)> = [
    { error: null },
    { error: { status: 429, code: "over_email_send_rate_limit", message: "Email rate limit exceeded" } },
    { error: { status: 429, code: "over_request_rate_limit", message: "Request rate limit reached" } },
    { error: { status: 429, message: "For security purposes, you can only request this after 42 seconds." } },
    { error: { status: 500, code: "unexpected_failure", message: `Error sending recovery email to ${ADDRESS}` } },
    { error: { status: 400, code: "user_not_found", message: "User not found" } },
    async () => {
      throw new TypeError("fetch failed");
    },
  ];

  it("a 429, any other error and a throw all answer the sent text, after the time floor", async () => {
    for (const outcome of outcomes) {
      vi.resetModules();
      padAuthAnswer.mockClear();
      const { actions, forwarded } = await withAuth(outcome);
      expect(await actions.forgotPasswordAction(null, form(ADDRESS))).toEqual({ ok: true, message: SENT });
      expect(forwarded.forwardedResetPassword).toHaveBeenCalledTimes(1);
      expect(padAuthAnswer).toHaveBeenCalledTimes(1);
    }
  });

  it("an error writes one redacted line (code and status, never the address); a success writes none", async () => {
    const quiet = await withAuth({ error: null });
    await quiet.actions.forgotPasswordAction(null, form(ADDRESS));
    expect(logged.filter((l) => l.includes("auth.reset_password"))).toEqual([]);
    vi.resetModules();
    const limited = await withAuth({ error: { status: 429, code: "over_email_send_rate_limit", message: `limit for ${ADDRESS}` } });
    await limited.actions.forgotPasswordAction(null, form(ADDRESS));
    const lines = logged.filter((l) => l.includes("auth.reset_password"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("over_email_send_rate_limit");
    expect(lines[0]).toContain('"level":"warn"');
    expect(logged.join("\n")).not.toContain(ADDRESS);
  });
});

describe("the time floor (./answer-floor.ts)", () => {
  it("waits up to 1,500 ms from the start of the Auth call, plus 0..249 ms", async () => {
    const { authAnswerWait, AUTH_ANSWER_FLOOR_MS, AUTH_ANSWER_JITTER_MS } = await import("@/features/auth/answer-floor");
    expect(AUTH_ANSWER_FLOOR_MS).toBe(1500);
    expect(AUTH_ANSWER_JITTER_MS).toBe(250);
    expect(authAnswerWait(100, () => 0)).toBe(1400);
    expect(authAnswerWait(100, () => 0.999999)).toBe(1649);
    expect(authAnswerWait(1499.2, () => 0)).toBe(1);
    expect(authAnswerWait(4000, () => 0.5)).toBe(125);
    expect(authAnswerWait(Number.NaN, () => 0)).toBe(1500);
  });

  it("padAuthAnswer really waits until the floor", async () => {
    const { padAuthAnswer: realPad } = await vi.importActual<typeof import("@/features/auth/answer-floor")>("@/features/auth/answer-floor");
    const started = performance.now();
    await realPad(started);
    expect(performance.now() - started).toBeGreaterThanOrEqual(1495);
  });

  it("the reset email waits the same floor, through the same forwarding call (no new call in that file)", () => {
    const source = readFileSync("src/features/auth/actions.ts", "utf8");
    const body = source.slice(source.indexOf("export async function forgotPasswordAction"));
    const own = body.slice(0, body.indexOf("\nexport ", 10));
    expect(own.indexOf("performance.now()")).toBeLessThan(own.indexOf("forwardedResetPassword("));
    expect(own.indexOf("padAuthAnswer(")).toBeGreaterThan(own.indexOf("forwardedResetPassword("));
    // owner (393) א: no answer but the sent text (no fail() after the Auth call)
    expect(own.slice(own.indexOf("forwardedResetPassword("))).not.toMatch(/\bfail\(/);
    // the magic link also pads after its Auth call, and never uses after() (the PKCE cookie must be on this response)
    const magic = source.slice(source.indexOf("export async function magicLinkAction"));
    const magicOwn = magic.slice(0, magic.indexOf("\nexport ", 10));
    expect(magicOwn.indexOf("padAuthAnswer(")).toBeGreaterThan(magicOwn.indexOf("forwardedMagicLink("));
    expect(magicOwn).not.toMatch(/\bafter\(/);
  });
});

describe("the Auth call", () => {
  it("never creates a user; the link returns through the callback on NEXT_PUBLIC_SITE_URL with a same-site next", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mexuzsystem.com/");
    const { actions, signInWithOtp, forwarded } = await withAuth({ error: null });
    await actions.magicLinkAction(null, form(ADDRESS, "/invite/abc123"));
    // owner (392) א: through the FXS-12 forwarding client only (shouldCreateUser false is fixed inside it)
    expect(forwarded.forwardedMagicLink).toHaveBeenCalledWith(ADDRESS, {
      emailRedirectTo: "https://mexuzsystem.com/auth/callback?next=%2Finvite%2Fabc123",
    });
    expect(signInWithOtp).not.toHaveBeenCalled();
    expect(forwarded.forwardedSignIn).not.toHaveBeenCalled();
    expect(forwarded.forwardedResetPassword).not.toHaveBeenCalled();
    // an outside next falls back to "/"
    await actions.magicLinkAction(null, form(ADDRESS, "//evil.example/x"));
    expect(forwarded.forwardedMagicLink).toHaveBeenLastCalledWith(ADDRESS, { emailRedirectTo: "https://mexuzsystem.com/auth/callback?next=%2F" });
  });

  it("a bad address is refused before Turnstile and Auth", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAAAAAAsitekeysitekey");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4AAAAAAAsecretsecretsecretsecretsecret");
    const { actions, forwarded } = await withAuth({ error: null });
    const result = await actions.magicLinkAction(null, form("not-an-address"));
    expect(result).toMatchObject({ ok: false });
    expect(result && !result.ok ? result.fieldErrors?.email : undefined).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(forwarded.forwardedMagicLink).not.toHaveBeenCalled();
  });

  it("logs the code only, never the address", async () => {
    const { actions } = await withAuth({ error: { status: 422, code: "otp_disabled", message: `Signups not allowed for ${ADDRESS}` } });
    await actions.magicLinkAction(null, form(ADDRESS));
    const line = logged.find((l) => l.includes("auth.magic_link"));
    expect(line).toBeTruthy();
    expect(line).toContain("otp_disabled");
    expect(logged.join("\n")).not.toContain(ADDRESS);
  });

  it("in the source: zod, then Turnstile, then the forwarding client; never the user's own client directly", () => {
    const source = readFileSync("src/features/auth/actions.ts", "utf8");
    const body = source.slice(source.indexOf("export async function magicLinkAction"));
    const own = body.slice(0, body.indexOf("\nexport ", 10));
    const zod = own.indexOf("magicLinkSchema.safeParse(");
    const captcha = own.indexOf("verifyTurnstile(");
    const call = own.indexOf("forwardedMagicLink(");
    expect(zod).toBeGreaterThan(0);
    expect(zod).toBeLessThan(captcha);
    expect(captcha).toBeLessThan(call);
    expect(own).not.toContain("createClient()");
    expect(own).not.toContain(".auth.signInWithOtp(");
    const forwarding = readFileSync("src/lib/supabase/auth-forwarding-server.ts", "utf8");
    const fn = forwarding.slice(forwarding.indexOf("export async function forwardedMagicLink"));
    expect(fn).toContain("shouldCreateUser: false");
  });
});

describe("the callback", () => {
  async function callback(url: string, mfa: { data: unknown; error: unknown }) {
    const verifyOtp = vi.fn(async () => ({ error: null }));
    const rpc = vi.fn(async () => mfa);
    vi.doMock("@/lib/env", () => ({ getSupabaseEnv: () => ({ url: "http://x", anonKey: "k" }) }));
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp }, rpc }) }));
    const { GET } = await import("@/app/auth/callback/route");
    const { NextRequest } = await import("next/server");
    const response = await GET(new NextRequest(url));
    vi.doUnmock("@/lib/env");
    return { location: response.headers.get("location"), verifyOtp };
  }

  it("a broken or expired link: one message that fits a sign-in link and a confirmation link", () => {
    const page = readFileSync("src/app/(auth)/login/page.tsx", "utf8");
    expect(page).toContain("הקישור אינו תקף או שפג תוקפו. אפשר לבקש קישור חדש או להיכנס עם סיסמה.");
    expect(page).not.toContain("הירשמו שוב");
  });

  it("a link session owes the code like a password session; without an authenticator it goes to next", async () => {
    const link = "https://mexuzsystem.com/auth/callback?next=%2Finvite%2Fabc&token_hash=h1&type=magiclink";
    const owes = await callback(link, { data: { enrolled: true, aal: "aal1" }, error: null });
    expect(owes.verifyOtp).toHaveBeenCalledWith({ token_hash: "h1", type: "magiclink" });
    expect(owes.location).toBe("https://mexuzsystem.com/login/mfa?next=%2Finvite%2Fabc");
    vi.resetModules();
    const plain = await callback(link, { data: { enrolled: false, aal: "aal1" }, error: null });
    expect(plain.location).toBe("https://mexuzsystem.com/invite/abc");
    vi.resetModules();
    const outside = await callback("https://mexuzsystem.com/auth/callback?next=%2F%2Fevil.example&token_hash=h1&type=magiclink", { data: null, error: { message: "x" } });
    expect(outside.location).toBe("https://mexuzsystem.com/");
  });

  it("asks for the two-step code after a link sign-in when the account has an authenticator", () => {
    const source = readFileSync("src/app/auth/callback/route.ts", "utf8");
    expect(source).toContain('"magiclink"');
    expect(source).toMatch(/rpc\("mfa_status"\)/);
    expect(source).toMatch(/paths\.loginMfa/);
    expect(source).toContain("safeNextPath(");
  });
});

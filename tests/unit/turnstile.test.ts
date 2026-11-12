import { ESLint } from "eslint";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Owner (275) א: Cloudflare Turnstile on the sign-in, sign-up and forgot-password forms, verified by OUR server before any
// Supabase Auth call (FXS-12: with the secret key Auth skips its own CAPTCHA). These tests pin the siteverify judgement, the
// off state, the order in the actions, the policy, and that the secret never reaches the browser.

const root = process.cwd();
const MODULE = "src/features/auth/turnstile-server.ts";
const ACTIONS = "src/features/auth/actions.ts";
const SECRET = "0x4AAAAAAAsecretsecretsecretsecretsecret";
const SITE = "0x4AAAAAAAsitekeysitekey";
const TOKEN = "0.tokenTOKENtoken-_abc.def";

let requestHeaders = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ getAll: () => [], set: () => undefined }),
}));

const logged: string[] = [];

beforeEach(() => {
  vi.resetModules();
  logged.length = 0;
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const good = { success: true, hostname: "mexuzsystem.com", action: "login", challenge_ts: "2026-11-12T10:00:00Z", "error-codes": [] };

async function check(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  const { checkTurnstileToken } = await import("@/features/auth/turnstile-server");
  return checkTurnstileToken({
    secret: SECRET,
    token: TOKEN,
    ip: "203.0.113.7",
    action: "login",
    hostnames: ["mexuzsystem.com", "erp-3yft.vercel.app"],
    fetchImpl,
    ...overrides,
  } as Parameters<typeof checkTurnstileToken>[0]);
}

describe("siteverify judgement", () => {
  it("passes only success true from an allowed hostname with the form's action; posts secret, token and address", async () => {
    const fetchImpl = vi.fn(ok(good));
    expect(await check(fetchImpl as unknown as typeof fetch)).toEqual({ result: "pass" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("secret")).toBe(SECRET);
    expect(body.get("response")).toBe(TOKEN);
    expect(body.get("remoteip")).toBe("203.0.113.7");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("an address that is not a plain IP is not sent", async () => {
    const fetchImpl = vi.fn(ok(good));
    await check(fetchImpl as unknown as typeof fetch, { ip: "not-an-ip" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).has("remoteip")).toBe(false);
  });

  it("refuses a failed token, a wrong hostname and a wrong action", async () => {
    expect(await check(ok({ success: false, "error-codes": ["invalid-input-response"] }) as unknown as typeof fetch)).toEqual({
      result: "refused",
      reason: "not_success",
      code: "invalid-input-response",
    });
    expect(await check(ok({ success: false, "error-codes": ["timeout-or-duplicate"] }) as unknown as typeof fetch)).toMatchObject({ result: "refused" });
    expect(await check(ok({ ...good, hostname: "evil.example" }) as unknown as typeof fetch)).toEqual({ result: "refused", reason: "wrong_hostname" });
    expect(await check(ok({ ...good, hostname: undefined }) as unknown as typeof fetch)).toEqual({ result: "refused", reason: "wrong_hostname" });
    expect(await check(ok({ ...good, action: "signup" }) as unknown as typeof fetch)).toEqual({ result: "refused", reason: "wrong_action" });
    expect(await check(ok({ ...good, success: "true" }) as unknown as typeof fetch)).toMatchObject({ result: "refused" });
  });

  it("a missing or malformed token is refused without calling Cloudflare", async () => {
    const fetchImpl = vi.fn(ok(good));
    for (const token of [null, undefined, "", 42]) {
      expect(await check(fetchImpl as unknown as typeof fetch, { token })).toEqual({ result: "refused", reason: "missing_token" });
    }
    for (const token of ["has space", "x".repeat(2049), "שלום"]) {
      expect(await check(fetchImpl as unknown as typeof fetch, { token })).toEqual({ result: "refused", reason: "bad_token" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("timeout, network error, 5xx, a non-JSON answer, internal-error and a refused secret are 'unavailable'", async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    expect(await check(hang, { timeoutMs: 20 })).toEqual({ result: "unavailable", reason: "timeout" });
    expect(await check((async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch)).toEqual({ result: "unavailable", reason: "network" });
    expect(await check(ok({}, 503) as unknown as typeof fetch)).toEqual({ result: "unavailable", reason: "http_error", code: "503" });
    expect(await check((async () => new Response("<html>", { status: 200 })) as typeof fetch)).toEqual({ result: "unavailable", reason: "bad_answer" });
    expect(await check(ok({ success: false, "error-codes": ["internal-error"] }) as unknown as typeof fetch)).toEqual({ result: "unavailable", reason: "internal_error" });
    expect(await check(ok({ success: false, "error-codes": ["invalid-input-secret"] }) as unknown as typeof fetch)).toMatchObject({
      result: "unavailable",
      reason: "secret_rejected",
    });
  });

  it("the default timeout is 3 seconds; only sign-in passes while Cloudflare is unavailable", async () => {
    const mod = await import("@/features/auth/turnstile-server");
    expect(mod.TURNSTILE_TIMEOUT_MS).toBe(3000);
    expect(mod.passesWhenUnavailable("login")).toBe(true);
    expect(mod.passesWhenUnavailable("signup")).toBe(false);
    expect(mod.passesWhenUnavailable("forgot_password")).toBe(false);
  });

  it("allowed hostnames: the two fixed ones and the site URL's host", async () => {
    const { allowedHostnames } = await import("@/features/auth/turnstile-server");
    expect(allowedHostnames(undefined).sort()).toEqual(["erp-3yft.vercel.app", "mexuzsystem.com"]);
    expect(allowedHostnames("https://App.Example.co.il/x").sort()).toEqual(["app.example.co.il", "erp-3yft.vercel.app", "mexuzsystem.com"]);
    expect(allowedHostnames("not a url").sort()).toEqual(["erp-3yft.vercel.app", "mexuzsystem.com"]);
  });
});

describe("keys and the off state", () => {
  it("both keys are needed; else no widget and no check", async () => {
    const { turnstileKeys } = await import("@/features/auth/turnstile-server");
    expect(turnstileKeys({})).toEqual({ off: "keys_not_set" });
    expect(turnstileKeys({ siteKey: SITE })).toEqual({ off: "secret_key_missing" });
    expect(turnstileKeys({ secret: SECRET })).toEqual({ off: "site_key_missing" });
    expect(turnstileKeys({ siteKey: "bad key!", secret: SECRET })).toEqual({ off: "site_key_invalid" });
    expect(turnstileKeys({ siteKey: ` ${SITE} `, secret: SECRET })).toEqual({ siteKey: SITE, secret: SECRET });
  });

  it("without keys: no site key for the forms, every form passes without a call, one 'off' line per process", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const mod = await import("@/features/auth/turnstile-server");
    const fetchImpl = vi.fn(ok(good));
    expect(mod.turnstileSiteKey()).toBeNull();
    for (const action of ["login", "signup", "forgot_password"] as const) {
      expect(await mod.verifyTurnstile(new FormData(), action, fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 0));
    expect(logged.filter((l) => l.includes("auth.turnstile_off"))).toHaveLength(1);
  });

  it("with only the site key: still off (no widget)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", SITE);
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const mod = await import("@/features/auth/turnstile-server");
    expect(mod.turnstileSiteKey()).toBeNull();
  });
});

describe("verifyTurnstile in a request", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", SITE);
    vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mexuzsystem.com");
  });
  const form = (token?: string) => {
    const f = new FormData();
    f.set("email", "a@example.com");
    if (token !== undefined) f.set("cf-turnstile-response", token);
    return f;
  };

  it("passes a good token, refuses a bad one with the Hebrew message, logs the reason and never the token, secret or address", async () => {
    const mod = await import("@/features/auth/turnstile-server");
    const { CAPTCHA_FAILED } = await import("@/lib/errors");
    expect(mod.turnstileSiteKey()).toBe(SITE);
    const fetchImpl = vi.fn(ok(good));
    expect(await mod.verifyTurnstile(form(TOKEN), "login", fetchImpl as unknown as typeof fetch)).toEqual({ ok: true });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(init.body)).get("remoteip")).toBe("203.0.113.7");

    expect(await mod.verifyTurnstile(form(), "login", fetchImpl as unknown as typeof fetch)).toEqual({ ok: false, message: CAPTCHA_FAILED });
    expect(await mod.verifyTurnstile(form(TOKEN), "signup", vi.fn(ok({ ...good, action: "login" })) as unknown as typeof fetch)).toEqual({
      ok: false,
      message: CAPTCHA_FAILED,
    });
    const text = logged.join("\n");
    expect(text).toContain("auth.turnstile_refused");
    expect(text).toContain("missing_token");
    expect(text).toContain("wrong_action");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("203.0.113.7");
  });

  it("Cloudflare unavailable: sign-in passes, sign-up and the reset email ask to try again", async () => {
    const mod = await import("@/features/auth/turnstile-server");
    const { CAPTCHA_UNAVAILABLE } = await import("@/lib/errors");
    const down = vi.fn(ok({}, 502)) as unknown as typeof fetch;
    expect(await mod.verifyTurnstile(form(TOKEN), "login", down)).toEqual({ ok: true });
    expect(await mod.verifyTurnstile(form(TOKEN), "signup", down)).toEqual({ ok: false, message: CAPTCHA_UNAVAILABLE });
    expect(await mod.verifyTurnstile(form(TOKEN), "forgot_password", down)).toEqual({ ok: false, message: CAPTCHA_UNAVAILABLE });
    const lines = logged.filter((l) => l.includes('"turnstile.unavailable"'));
    // one line per form a minute; no token, secret or address
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).toContain("http_error");
    for (const text of [TOKEN, SECRET, "203.0.113.7"]) expect(lines.join("\n")).not.toContain(text);
    await mod.verifyTurnstile(form(TOKEN), "login", down);
    expect(logged.filter((l) => l.includes('"turnstile.unavailable"'))).toHaveLength(3);
    expect(logged.join("\n")).not.toContain("auth.turnstile_skipped");
  });

  it("our secret refused by Cloudflare is logged at error level, while the sign-in still passes", async () => {
    const mod = await import("@/features/auth/turnstile-server");
    const rejected = vi.fn(ok({ success: false, "error-codes": ["invalid-input-secret"] })) as unknown as typeof fetch;
    expect(await mod.verifyTurnstile(form(TOKEN), "login", rejected)).toEqual({ ok: true });
    const line = logged.find((l) => l.includes("secret_rejected"));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ level: "error", event: "turnstile.unavailable", reason: "secret_rejected", what: "login" });
    expect(line).not.toContain(SECRET);
  });

  it("the same reason and form are logged at most once a minute", async () => {
    const mod = await import("@/features/auth/turnstile-server");
    for (let i = 0; i < 5; i++) await mod.verifyTurnstile(form(), "login");
    expect(logged.filter((l) => l.includes("auth.turnstile_refused"))).toHaveLength(1);
  });
});

describe("the auth actions check Turnstile before any Supabase call", () => {
  it("a refusal stops each of the three actions before the forwarding client is called", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", SITE);
    vi.stubEnv("TURNSTILE_SECRET_KEY", SECRET);
    const forwarded = { forwardedSignIn: vi.fn(), forwardedSignUp: vi.fn(), forwardedResetPassword: vi.fn() };
    vi.doMock("@/lib/supabase/auth-forwarding-server", () => forwarded);
    const resend = vi.fn();
    vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { resend } }) }));
    vi.stubGlobal("fetch", vi.fn(ok({ success: false, "error-codes": ["invalid-input-response"] })));
    const actions = await import("@/features/auth/actions");
    const f = new FormData();
    f.set("email", "a@example.com");
    f.set("password", "a-long-password-1");
    f.set("full_name", "ישראל ישראלי");
    f.set("cf-turnstile-response", TOKEN);
    const results = [await actions.signInAction(null, f), await actions.signUpAction(null, f), await actions.forgotPasswordAction(null, f)];
    for (const result of results) {
      expect(result?.ok).toBe(false);
      // the token is never sent back to the page
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
    expect(forwarded.forwardedSignIn).not.toHaveBeenCalled();
    expect(forwarded.forwardedSignUp).not.toHaveBeenCalled();
    expect(forwarded.forwardedResetPassword).not.toHaveBeenCalled();
    // sign-up's "send again": the token is an argument; refused without one or with a bad one, before Auth
    const { CAPTCHA_FAILED, CAPTCHA_UNAVAILABLE } = await import("@/lib/errors");
    expect(await actions.resendConfirmationAction("a@example.com", "/")).toEqual({ ok: false, message: CAPTCHA_FAILED });
    expect(await actions.resendConfirmationAction("a@example.com", "/", TOKEN)).toEqual({ ok: false, message: CAPTCHA_FAILED });
    // Cloudflare unavailable: refused like sign-up (owner (319) א)
    vi.stubGlobal("fetch", vi.fn(ok({}, 503)));
    expect(await actions.resendConfirmationAction("a@example.com", "/", TOKEN)).toEqual({ ok: false, message: CAPTCHA_UNAVAILABLE });
    expect(resend).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("in the source, verifyTurnstile comes before each forwarding call", () => {
    const source = readFileSync(ACTIONS, "utf8");
    for (const [fn, call] of [
      ["signInAction", "forwardedSignIn("],
      ["signUpAction", "forwardedSignUp("],
      ["forgotPasswordAction", "forwardedResetPassword("],
      ["resendConfirmationAction", ".auth.resend("],
    ]) {
      const body = source.slice(source.indexOf(`export async function ${fn}`));
      const end = body.indexOf("\nexport ", 10);
      const own = end === -1 ? body : body.slice(0, end);
      const check = own.search(/verifyTurnstile(Token)?\(/);
      expect(check, fn).toBeGreaterThan(0);
      expect(check, fn).toBeLessThan(own.indexOf(call));
      // a field-validation failure (the only answer with fieldErrors) comes before the check, so it never uses the token
      expect(own.slice(check), fn).not.toMatch(/fieldErrors|invalid\(/);
    }
  });

  it("the widget is reset only after an answer that used the token", async () => {
    const { turnstileTokenUsed } = await import("@/features/auth/turnstile");
    expect(turnstileTokenUsed(null)).toBe(false);
    expect(turnstileTokenUsed({ ok: false, fieldErrors: { email: "x" } })).toBe(false);
    expect(turnstileTokenUsed({ ok: false })).toBe(true);
    expect(turnstileTokenUsed({ ok: false, fieldErrors: {} })).toBe(true);
    expect(turnstileTokenUsed({ ok: true })).toBe(true);
    const widget = readFileSync("src/features/auth/components/turnstile-widget.tsx", "utf8");
    expect(widget).toContain("if (!turnstileTokenUsed(resetSignal)) return;");
  });
});

describe("policy (CSP)", () => {
  it("adds Turnstile's origin to script-src and frame-src only when asked", async () => {
    const { contentSecurityPolicy, CSP_TURNSTILE_ORIGIN } = await import("@/lib/csp");
    const { TURNSTILE_ORIGIN, TURNSTILE_SCRIPT_URL } = await import("@/features/auth/turnstile");
    expect(CSP_TURNSTILE_ORIGIN).toBe(TURNSTILE_ORIGIN);
    expect(new URL(TURNSTILE_SCRIPT_URL).origin).toBe(TURNSTILE_ORIGIN);
    const base = { nonce: "abc", supabaseUrl: "https://ref.supabase.co", isDev: false, publicForm: false };
    const off = contentSecurityPolicy(base);
    expect(off).not.toContain("challenges.cloudflare.com");
    expect(off).not.toContain("frame-src");
    const on = contentSecurityPolicy({ ...base, turnstile: true });
    expect(on).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic' https://challenges.cloudflare.com;");
    expect(on).toContain("frame-src 'self' https://challenges.cloudflare.com;");
    expect(on).toContain("connect-src 'self' https://ref.supabase.co wss://ref.supabase.co;");
    expect(on).toContain("frame-ancestors 'none'");
    expect(on.match(/challenges\.cloudflare\.com/g)).toHaveLength(2);
  });

  it("allowed on the app's pages while the site key is set, never on the customer pages under /f/", async () => {
    const { turnstileAllowed } = await import("@/lib/supabase/proxy");
    for (const path of ["/login", "/signup", "/forgot-password", "/", "/app", "/o/x/leads"]) {
      expect(turnstileAllowed(path, SITE), path).toBe(true);
      expect(turnstileAllowed(path, ""), path).toBe(false);
      expect(turnstileAllowed(path, undefined), path).toBe(false);
    }
    for (const path of ["/f/abc", "/f/quote/abc", "/f/sign/x"]) expect(turnstileAllowed(path, SITE), path).toBe(false);
  });

  it("the theme follows the page; the actions are short codes Cloudflare accepts", async () => {
    const { turnstileTheme, TURNSTILE_ACTIONS } = await import("@/features/auth/turnstile");
    expect(turnstileTheme("dark")).toBe("dark");
    expect(turnstileTheme("light")).toBe("light");
    expect(turnstileTheme(null)).toBe("light");
    for (const a of Object.values(TURNSTILE_ACTIONS)) expect(a).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
  });
});

describe("the secret never reaches the browser", () => {
  const IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  const resolveModule = (from: string, spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = join("src", spec.slice(2));
    else if (spec.startsWith(".")) base = join(from, "..", spec);
    else return null;
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
      if (/\.(ts|tsx)$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const isServerActions = (file: string) => /^\s*["']use server["']/.test(readFileSync(file, "utf8"));
  const reach = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      // a "use server" module is a reference in a client bundle, so the walk stops there
      if (file !== start && isServerActions(file)) continue;
      for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
        const next = resolveModule(file, match[1]);
        if (next) queue.push(next);
      }
    }
    return seen;
  };
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [path] : [];
    });

  it("the module is server-only and no client component reaches it", () => {
    expect(readFileSync(MODULE, "utf8").split("\n")[0]).toBe('import "server-only";');
    const clients = sourceFiles("src").filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(clients).toContain(join("src", "features", "auth", "components", "turnstile-widget.tsx"));
    for (const client of clients) {
      expect(reach(client).has(MODULE), client).toBe(false);
      expect(readFileSync(client, "utf8"), client).not.toContain("TURNSTILE_SECRET_KEY");
    }
  });

  it("TURNSTILE_SECRET_KEY is named in one file of src only, never NEXT_PUBLIC_", () => {
    expect(sourceFiles("src").filter((f) => readFileSync(f, "utf8").includes("TURNSTILE_SECRET_KEY"))).toEqual([MODULE]);
    for (const f of [...sourceFiles("src"), "next.config.ts", ".env.example"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/NEXT_PUBLIC_TURNSTILE_SECRET/);
    }
    const env = readFileSync(".env.example", "utf8");
    expect(env).toMatch(/^TURNSTILE_SECRET_KEY=$/m);
    expect(env).toMatch(/^NEXT_PUBLIC_TURNSTILE_SITE_KEY=$/m);
  });

  it("lint refuses the secret's name anywhere else", async () => {
    const eslint = new ESLint({ cwd: root });
    const syntax = async (code: string, file: string) =>
      (await eslint.lintText(code, { filePath: join(root, file) }))[0].messages.filter((m) => m.ruleId === "no-restricted-syntax").length;
    for (const code of [
      "export const s = process.env.TURNSTILE_SECRET_KEY;\n",
      'export const s = process.env["TURNSTILE_SECRET_KEY"];\n',
      "const { TURNSTILE_SECRET_KEY: s } = process.env;\nexport { s };\n",
    ]) {
      for (const file of ["src/features/x/y.ts", ACTIONS, "src/lib/supabase/auth-forwarding-server.ts", "src/features/background/user-token.ts", "src/features/auth/components/turnstile-widget.tsx"]) {
        expect(await syntax(code, file), `${code} in ${file}`).toBeGreaterThan(0);
      }
    }
    // the check itself still may not read the other two secrets
    expect(await syntax("export const s = process.env.SUPABASE_SECRET_KEY;\n", MODULE)).toBeGreaterThan(0);
    expect(await syntax("export const s = process.env.SUPABASE_JWT_SECRET;\n", MODULE)).toBeGreaterThan(0);
    const real = await eslint.lintFiles([MODULE]);
    expect(real.flatMap((r) => r.messages.filter((m) => m.ruleId === "no-restricted-syntax"))).toEqual([]);
  }, 120_000);
});

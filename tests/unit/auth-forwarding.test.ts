import { ESLint } from "eslint";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// FXS-12 (owner (281) א): one server file forwards the user's address to Supabase Auth's rate limit on sign-in, sign-up
// and password reset with the project's secret key. These tests pin the address rule, the header, the fallback, and that
// the key can never reach the browser.

const root = process.cwd();
const MODULE = "src/lib/supabase/auth-forwarding-server.ts";
const ACTIONS = "src/features/auth/actions.ts";
const KEY = "sb_secret_abcdefghijklmnopqrstuvwxyz012345";

type Call = { url: string; key: string; options: { global?: { headers?: Record<string, string> }; cookieOptions?: unknown } };
const created: Call[] = [];
const forwardedAuth = {
  signInWithPassword: vi.fn(async () => ({ data: { user: { id: "u1" }, session: { access_token: "at", refresh_token: "rt" } }, error: null })),
  signUp: vi.fn(async () => ({ data: { user: { id: "u1", identities: [{}] }, session: null }, error: null })),
  resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
};
const ownAuth = {
  signInWithPassword: vi.fn(async () => ({ data: { user: { id: "u1" }, session: { access_token: "own", refresh_token: "own" } }, error: null })),
  signUp: vi.fn(async () => ({ data: { user: null, session: null }, error: null })),
  resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
  setSession: vi.fn(async () => ({ data: {}, error: null })),
  signOut: vi.fn(async () => ({ error: null })),
};
// the gateway's refusal of a secret key: 401 with no Auth error code (a revoked key, or the browser block)
const keyRefusal = { data: { user: null, session: null }, error: { name: "AuthApiError", status: 401, code: undefined, message: "Invalid API key" } };
let requestHeaders = new Headers();

vi.mock("@supabase/ssr", () => ({
  createServerClient: (url: string, key: string, options: Call["options"]) => {
    created.push({ url, key, options });
    return { auth: forwardedAuth };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: ownAuth }),
  sessionCookieMethods: () => ({ getAll: () => [], setAll: () => undefined }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [] }),
  headers: async () => requestHeaders,
}));

const logged: string[] = [];

beforeEach(() => {
  vi.resetModules();
  created.length = 0;
  logged.length = 0;
  for (const fn of [...Object.values(forwardedAuth), ...Object.values(ownAuth)]) fn.mockClear();
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "Mozilla/5.0 test" });
});

afterEach(() => {
  delete process.env.SUPABASE_SECRET_KEY;
  vi.restoreAllMocks();
});

describe("FXS-12: the address, the key and the header", () => {
  it("takes the first x-forwarded-for value, else x-real-ip, and only a plain IPv4 or IPv6 address", async () => {
    const { forwardableIp } = await import("@/lib/supabase/auth-forwarding-server");
    const ip = (h: Record<string, string>) => forwardableIp(new Headers(h));
    expect(ip({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })).toBe("203.0.113.7");
    expect(ip({ "x-forwarded-for": " 2001:db8::1 " })).toBe("2001:db8::1");
    expect(ip({ "x-real-ip": "198.51.100.2" })).toBe("198.51.100.2");
    expect(ip({ "x-forwarded-for": "::ffff:192.0.2.1" })).toBe("::ffff:192.0.2.1");
    for (const bad of ["unknown", "203.0.113.7:443", "[2001:db8::1]", "999.1.1.1", "1.2.3", "<script>", "a".repeat(60), "203.0.113.7 x"]) {
      expect(ip({ "x-forwarded-for": bad }), bad).toBeNull();
    }
    expect(ip({})).toBeNull();
  });

  it("accepts only a secret key (sb_secret_), never a legacy or publishable key", async () => {
    const { secretKeyState } = await import("@/lib/supabase/auth-forwarding-server");
    expect(secretKeyState(undefined)).toEqual({ reason: "secret_key_not_set" });
    expect(secretKeyState("  ")).toEqual({ reason: "secret_key_not_set" });
    expect(secretKeyState("eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x")).toEqual({ reason: "secret_key_invalid" });
    expect(secretKeyState("sb_publishable_abcdefghijklmnop")).toEqual({ reason: "secret_key_invalid" });
    expect(secretKeyState("sb_secret_short")).toEqual({ reason: "secret_key_invalid" });
    expect(secretKeyState(` ${KEY} `)).toEqual({ key: KEY });
  });

  it("sends the address in sb-forwarded-for and a fixed server User-Agent, never the browser's", async () => {
    const { forwardingHeaders, FORWARDING_USER_AGENT } = await import("@/lib/supabase/auth-forwarding-server");
    expect(FORWARDING_USER_AGENT).toBe("mexuz-server");
    expect(FORWARDING_USER_AGENT).not.toMatch(/Mozilla|Chrome|Safari|Gecko|AppleWebKit|Edg|Firefox/i);
    expect(forwardingHeaders("203.0.113.7")).toEqual({ "sb-forwarded-for": "203.0.113.7", "User-Agent": "mexuz-server" });
    expect(forwardingHeaders("2001:db8::1")).toEqual({ "sb-forwarded-for": "2001:db8::1", "User-Agent": "mexuz-server" });
  });

  it("a key refusal is a 401/403 without Auth's own code; Auth's own answers are not", async () => {
    const { keyRefused } = await import("@/lib/supabase/auth-forwarding-server");
    expect(keyRefused({ status: 401 })).toBe(true);
    expect(keyRefused({ status: 403 })).toBe(true);
    expect(keyRefused({ status: 401, code: "no_authorization" })).toBe(true);
    expect(keyRefused({ status: 400, code: "invalid_credentials" })).toBe(false);
    expect(keyRefused({ status: 401, code: "invalid_credentials" })).toBe(false);
    expect(keyRefused({ status: 403, code: "user_banned" })).toBe(false);
    expect(keyRefused({ status: 429, code: "over_request_rate_limit" })).toBe(false);
    expect(keyRefused({ status: 500 })).toBe(false);
    expect(keyRefused(null)).toBe(false);
  });
});

describe("FXS-12: the three calls", () => {
  it("with the key: one client with the key and the header, the cookies' own options, and the session handed to the request's client", async () => {
    process.env.SUPABASE_SECRET_KEY = KEY;
    const mod = await import("@/lib/supabase/auth-forwarding-server");
    const result = await mod.forwardedSignIn({ email: "a@example.com", password: "pw" });
    expect(result.error).toBeNull();
    expect(created).toHaveLength(1);
    expect(created[0].url).toBe("https://example.supabase.co");
    expect(created[0].key).toBe(KEY);
    expect(created[0].options.global?.headers).toEqual({ "sb-forwarded-for": "203.0.113.7", "User-Agent": "mexuz-server" });
    expect(JSON.stringify(created[0].options)).not.toContain("Mozilla");
    expect(created[0].options.cookieOptions).toEqual({ secure: false, sameSite: "lax", path: "/" });
    expect(forwardedAuth.signInWithPassword).toHaveBeenCalledWith({ email: "a@example.com", password: "pw" });
    expect(ownAuth.signInWithPassword).not.toHaveBeenCalled();
    expect(ownAuth.setSession).toHaveBeenCalledWith({ access_token: "at", refresh_token: "rt" });

    await mod.forwardedSignUp({ email: "a@example.com", password: "pw" });
    await mod.forwardedResetPassword("a@example.com", { redirectTo: "https://x/auth/callback" });
    expect(forwardedAuth.signUp).toHaveBeenCalledTimes(1);
    expect(forwardedAuth.resetPasswordForEmail).toHaveBeenCalledWith("a@example.com", { redirectTo: "https://x/auth/callback" });
    expect(ownAuth.signUp).not.toHaveBeenCalled();
    expect(ownAuth.resetPasswordForEmail).not.toHaveBeenCalled();
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("a failed hand-over of the session signs the request's client out locally and is the sign-in's error", async () => {
    process.env.SUPABASE_SECRET_KEY = KEY;
    ownAuth.setSession.mockResolvedValueOnce({ data: {}, error: { message: "bad" } } as never);
    const mod = await import("@/lib/supabase/auth-forwarding-server");
    const result = await mod.forwardedSignIn({ email: "a@example.com", password: "pw" });
    expect(result.error).toEqual({ message: "bad" });
    expect(result.data.session).toBeNull();
    expect(ownAuth.signOut).toHaveBeenCalledTimes(1);
    expect(ownAuth.signOut).toHaveBeenCalledWith({ scope: "local" });
    // a hand-over that works signs nobody out
    await mod.forwardedSignIn({ email: "a@example.com", password: "pw" });
    expect(ownAuth.signOut).toHaveBeenCalledTimes(1);
  });

  it("a refused key (revoked, rotated, blocked) never locks anyone out: each call is made once more through the user's client", async () => {
    process.env.SUPABASE_SECRET_KEY = KEY;
    forwardedAuth.signInWithPassword.mockResolvedValueOnce(keyRefusal as never);
    forwardedAuth.signUp.mockResolvedValueOnce(keyRefusal as never);
    forwardedAuth.resetPasswordForEmail.mockResolvedValueOnce({ data: null, error: { status: 403, message: "Forbidden" } } as never);
    const mod = await import("@/lib/supabase/auth-forwarding-server");
    const signIn = await mod.forwardedSignIn({ email: "a@example.com", password: "pw" });
    expect(signIn.error).toBeNull();
    expect(signIn.data.session).toEqual({ access_token: "own", refresh_token: "own" });
    expect(forwardedAuth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(ownAuth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(ownAuth.signInWithPassword).toHaveBeenCalledWith({ email: "a@example.com", password: "pw" });
    // the user's own client signed in itself: nothing to hand over
    expect(ownAuth.setSession).not.toHaveBeenCalled();
    expect((await mod.forwardedSignUp({ email: "a@example.com", password: "pw" })).error).toBeNull();
    expect(ownAuth.signUp).toHaveBeenCalledTimes(1);
    expect((await mod.forwardedResetPassword("a@example.com", { redirectTo: "https://x" })).error).toBeNull();
    expect(ownAuth.resetPasswordForEmail).toHaveBeenCalledWith("a@example.com", { redirectTo: "https://x" });
    const lines = logged.filter((l) => l.includes("secret_key_refused"));
    expect(lines).toHaveLength(1);
    expect(logged.join("\n")).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain("203.0.113.7");
  });

  it("Auth's own refusal (wrong password, 400 invalid_credentials) is answered as is, never retried", async () => {
    process.env.SUPABASE_SECRET_KEY = KEY;
    const wrong = { data: { user: null, session: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
    forwardedAuth.signInWithPassword.mockResolvedValueOnce(wrong as never);
    const mod = await import("@/lib/supabase/auth-forwarding-server");
    const result = await mod.forwardedSignIn({ email: "a@example.com", password: "nope" });
    expect(result).toEqual(wrong);
    expect(ownAuth.signInWithPassword).not.toHaveBeenCalled();
    expect(ownAuth.setSession).not.toHaveBeenCalled();
    expect(logged.filter((l) => l.includes("auth.ip_forwarding_off"))).toEqual([]);
  });

  it("without the key, or with a bad address: today's path unchanged, no secret client, one line per reason", async () => {
    const mod = await import("@/lib/supabase/auth-forwarding-server");
    await mod.forwardedSignIn({ email: "a@example.com", password: "pw" });
    await mod.forwardedSignUp({ email: "a@example.com", password: "pw" });
    await mod.forwardedResetPassword("a@example.com", { redirectTo: "https://x" });
    expect(created).toHaveLength(0);
    expect(ownAuth.signInWithPassword).toHaveBeenCalledTimes(1);
    expect(ownAuth.signUp).toHaveBeenCalledTimes(1);
    expect(ownAuth.resetPasswordForEmail).toHaveBeenCalledTimes(1);
    expect(ownAuth.setSession).not.toHaveBeenCalled();
    const lines = logged.filter((l) => l.includes("auth.ip_forwarding_off"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("secret_key_not_set");

    process.env.SUPABASE_SECRET_KEY = KEY;
    requestHeaders = new Headers({ "x-forwarded-for": "not-an-ip" });
    await mod.forwardedSignIn({ email: "a@example.com", password: "pw" });
    expect(created).toHaveLength(0);
    expect(ownAuth.signInWithPassword).toHaveBeenCalledTimes(2);
    const ipLines = logged.filter((l) => l.includes("client_ip_invalid"));
    expect(ipLines).toHaveLength(1);
    expect(logged.join("\n")).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain("not-an-ip");
  });
});

describe("FXS-12: the key never reaches the browser", () => {
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
  // the modules a file's bundle holds: a "use server" module is a reference in a client bundle, so the walk stops there
  const reach = (start: string, stopAtServerActions: boolean): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (stopAtServerActions && file !== start && isServerActions(file)) continue;
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

  it("the module is server-only and the actions that import it are server actions", () => {
    const source = readFileSync(MODULE, "utf8");
    expect(source.split("\n")[0]).toBe('import "server-only";');
    expect(isServerActions(ACTIONS)).toBe(true);
    expect(reach(ACTIONS, false).has(MODULE)).toBe(true);
  });

  it("no client component reaches the module, directly or through other files", () => {
    const clients = sourceFiles("src").filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    expect(clients.length).toBeGreaterThan(10);
    expect(clients).toContain(join("src", "features", "auth", "components", "login-form.tsx"));
    for (const client of clients) expect(reach(client, true).has(MODULE), client).toBe(false);
  });

  it("the key is SUPABASE_SECRET_KEY, never NEXT_PUBLIC_, named in one file of src only", () => {
    const files = sourceFiles("src").filter((f) => readFileSync(f, "utf8").includes("SUPABASE_SECRET_KEY"));
    expect(files).toEqual([MODULE]);
    expect(readFileSync(MODULE, "utf8")).toContain("process.env.SUPABASE_SECRET_KEY");
    for (const f of [...sourceFiles("src"), "next.config.ts", ".env.example"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*SECRET/);
    }
    expect(readFileSync(".env.example", "utf8")).toMatch(/^SUPABASE_SECRET_KEY=$/m);
  });

  it("lint refuses the key's name and the module's import anywhere else", async () => {
    const eslint = new ESLint({ cwd: root });
    const syntax = async (code: string, file: string) =>
      (await eslint.lintText(code, { filePath: join(root, file) }))[0].messages.filter((m) => m.ruleId === "no-restricted-syntax").length;
    const imports = async (code: string, file: string) =>
      (await eslint.lintText(code, { filePath: join(root, file) }))[0].messages.filter((m) => m.ruleId === "no-restricted-imports").length;
    for (const code of [
      "export const s = process.env.SUPABASE_SECRET_KEY;\n",
      'export const s = process.env["SUPABASE_SECRET_KEY"];\n',
      "const { SUPABASE_SECRET_KEY: s } = process.env;\nexport { s };\n",
    ]) {
      for (const file of ["src/features/x/y.ts", ACTIONS, "src/lib/supabase/server.ts", "src/features/background/user-token.ts"]) {
        expect(await syntax(code, file), `${code} in ${file}`).toBeGreaterThan(0);
      }
    }
    const use = 'import { forwardedSignIn } from "@/lib/supabase/auth-forwarding-server";\nexport const x = forwardedSignIn;\n';
    for (const file of ["src/features/x/y.ts", "src/app/login/page.tsx", "src/features/intake/server.ts", "src/features/jobs/run-server.ts", "src/lib/supabase/server.ts"]) {
      expect(await imports(use, file), file).toBe(1);
    }
    expect(await imports(use.replace("@/lib/supabase/auth-forwarding-server", "./auth-forwarding-server"), "src/lib/supabase/proxy.ts")).toBe(1);
    expect(await imports(use, ACTIONS)).toBe(0);
    // the actions still may not take the service key or the person's token
    expect(await imports('import { createServiceClient } from "@/lib/supabase/service";\nexport const x = createServiceClient;\n', ACTIONS)).toBe(1);
    // the real files pass
    const real = await eslint.lintFiles([MODULE, ACTIONS]);
    expect(real.flatMap((r) => r.messages.filter((m) => m.ruleId === "no-restricted-syntax" || m.ruleId === "no-restricted-imports"))).toEqual([]);
  }, 120_000);
});

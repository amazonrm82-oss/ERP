import { createHmac, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { ESLint } from "eslint";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { backgroundJobsReady, createBackgroundTokenSource, TokenRefused } from "@/features/background/user-token";
import type { ClaimedJob } from "@/features/jobs/registry";

// IMP-04, owner (421) א (18 November 2026): the background job's token may be signed ES256 with the private half of the
// standby key the owner imported into Supabase. Only while BACKGROUND_JWT_SIGNING=es256 and the JWK is a good P-256 key
// with a kid; otherwise HS256 exactly as before; a bad key or an unknown switch signs nothing and logs one redacted line.

const root = process.cwd();
const USER = "66666666-6666-4666-8666-666666666666";
const REQ = "55555555-5555-4555-8555-555555555555";
const SESSION = "88888888-8888-4888-8888-888888888888";
const SECRET = "s".repeat(40);
const CLAIMS = { sub: USER, role: "authenticated", aal: "aal1", session_id: SESSION, crm_background: REQ };
const NOW = 1_000_000;

const job: ClaimedJob = {
  id: "11111111-1111-4111-8111-111111111111",
  lease: "22222222-2222-4222-8222-222222222222",
  kind: "import.run",
  organization_id: "33333333-3333-4333-8333-333333333333",
  payload: { request_id: REQ, user_id: USER },
  attempt: 1,
};

function service(log: string[]) {
  return {
    rpc: async (name: string) => {
      log.push(name);
      return { data: { ok: true, claims: CLAIMS, locked_until: new Date(NOW + 900_000).toISOString() }, error: null };
    },
  } as never;
}

function freshJwk(kid = "standby-test-kid") {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...privateKey.export({ format: "jwk" }), kid, alg: "ES256" } as Record<string, string>;
}

const parts = (token: string) => {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()),
    input: `${header}.${payload}`,
    signature: Buffer.from(signature, "base64url"),
    rawSignature: signature,
  };
};

const ENV_KEYS = ["BACKGROUND_JWT_SIGNING", "BACKGROUND_JWT_PRIVATE_JWK", "SUPABASE_JWT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= "anon-key-for-tests";
});
beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.SUPABASE_JWT_SECRET = SECRET;
  delete process.env.BACKGROUND_JWT_SIGNING;
  delete process.env.BACKGROUND_JWT_PRIVATE_JWK;
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("IMP-04: ES256 with the standby key (owner (421) א)", () => {
  it("signs ES256 with the kid; the signature verifies with the public key; same claims; asks the database first", async () => {
    const jwk = freshJwk();
    process.env.BACKGROUND_JWT_SIGNING = "es256";
    process.env.BACKGROUND_JWT_PRIVATE_JWK = JSON.stringify(jwk);
    expect(backgroundJobsReady()).toBe(true);
    const log: string[] = [];
    const token = parts(await createBackgroundTokenSource(service(log), job, { now: () => NOW }).token());
    expect(log).toEqual(["background_job_token"]);
    expect(token.header).toEqual({ alg: "ES256", typ: "JWT", kid: "standby-test-kid" });
    expect(token.payload).toEqual({ aud: "authenticated", sub: USER, role: "authenticated", aal: "aal1", session_id: SESSION, crm_background: REQ, iat: 1_000, exp: 1_600 });
    expect(token.signature).toHaveLength(64);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    expect(verify("sha256", Buffer.from(token.input), { key: publicKey, dsaEncoding: "ieee-p1363" }, token.signature)).toBe(true);
    // another key's public half does not verify it
    const other = freshJwk();
    const otherPublic = createPublicKey({ key: { kty: "EC", crv: "P-256", x: other.x, y: other.y }, format: "jwk" });
    expect(verify("sha256", Buffer.from(token.input), { key: otherPublic, dsaEncoding: "ieee-p1363" }, token.signature)).toBe(false);
    // the legacy secret is not used at all
    expect(token.rawSignature).not.toBe(createHmac("sha256", SECRET).update(token.input).digest("base64url"));
  });

  it("switch off (unset, empty or hs256): HS256 exactly as before, even with a key present", async () => {
    process.env.BACKGROUND_JWT_PRIVATE_JWK = JSON.stringify(freshJwk());
    for (const mode of [undefined, "", "hs256", " HS256 "]) {
      if (mode === undefined) delete process.env.BACKGROUND_JWT_SIGNING;
      else process.env.BACKGROUND_JWT_SIGNING = mode;
      const token = parts(await createBackgroundTokenSource(service([]), job, { now: () => NOW }).token());
      expect(token.header, String(mode)).toEqual({ alg: "HS256", typ: "JWT" });
      expect(token.rawSignature).toBe(createHmac("sha256", SECRET).update(token.input).digest("base64url"));
    }
    // and HS256 without its secret signs nothing, as before
    delete process.env.BACKGROUND_JWT_SIGNING;
    delete process.env.SUPABASE_JWT_SECRET;
    expect(backgroundJobsReady()).toBe(false);
    const src = createBackgroundTokenSource(service([]), job, { now: () => NOW });
    await expect(src.token()).rejects.toBeInstanceOf(TokenRefused);
    expect(src.refused()).toBe("not_configured");
  });

  it("es256 with a missing or bad key: refused before the database, never HS256, one redacted line, no key material", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const good = freshJwk();
    const p384 = { ...(generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey.export({ format: "jwk" }) as Record<string, string>), kid: "k" };
    const rsa = { ...(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "jwk" }) as Record<string, string>), kid: "k" };
    const mixed = { ...good, x: freshJwk().x };
    const publicOnly = Object.fromEntries(Object.entries(good).filter(([name]) => name !== "d"));
    const noKid = Object.fromEntries(Object.entries(good).filter(([name]) => name !== "kid"));
    const bad: Array<string | undefined> = [
      undefined,
      "",
      "not json {",
      "[]",
      JSON.stringify(publicOnly),
      JSON.stringify(noKid),
      JSON.stringify({ ...good, kid: "" }),
      JSON.stringify({ ...good, kid: "a\"b" }),
      JSON.stringify({ ...good, alg: "RS256" }),
      JSON.stringify({ ...good, crv: "P-384" }),
      JSON.stringify(p384),
      JSON.stringify(rsa),
      JSON.stringify(mixed),
      JSON.stringify({ ...good, d: "AAAA" }),
    ];
    process.env.BACKGROUND_JWT_SIGNING = "es256";
    for (const text of bad) {
      if (text === undefined) delete process.env.BACKGROUND_JWT_PRIVATE_JWK;
      else process.env.BACKGROUND_JWT_PRIVATE_JWK = text;
      expect(backgroundJobsReady(), String(text)).toBe(false);
      const log: string[] = [];
      const src = createBackgroundTokenSource(service(log), job, { now: () => NOW });
      await expect(src.token(), String(text)).rejects.toBeInstanceOf(TokenRefused);
      expect(src.refused()).toBe("key_invalid");
      expect(log, "never asks the database with a key it cannot use").toEqual([]);
    }
    // an unknown switch value fails closed too
    process.env.BACKGROUND_JWT_SIGNING = "es265";
    process.env.BACKGROUND_JWT_PRIVATE_JWK = JSON.stringify(good);
    const unknown = createBackgroundTokenSource(service([]), job, { now: () => NOW });
    await expect(unknown.token()).rejects.toBeInstanceOf(TokenRefused);
    expect(unknown.refused()).toBe("signing_unknown");
    expect(backgroundJobsReady()).toBe(false);

    // one line per process, by reason code only
    const keyLines = lines.filter((line) => line.includes("background.token_key_invalid"));
    expect(keyLines).toHaveLength(1);
    expect(JSON.parse(keyLines[0])).toMatchObject({ level: "error", event: "background.token_key_invalid", reason: "key_invalid" });
    const everything = lines.join("\n");
    for (const key of [good, p384, rsa, mixed]) {
      for (const [name, value] of Object.entries(key)) {
        if (["kty", "crv", "kid", "alg", "e"].includes(name)) continue;
        expect(everything, name).not.toContain(value);
        expect(everything, name).not.toContain(value.slice(0, 12));
      }
    }
  });

  it("BACKGROUND_JWT_PRIVATE_JWK is named in one file of src only, lint refuses it elsewhere, never NEXT_PUBLIC_", async () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|mjs|js)$/.test(name) && readFileSync(path, "utf8").includes("BACKGROUND_JWT_PRIVATE_JWK")) files.push(path.slice(root.length + 1));
      }
    };
    walk(join(root, "src"));
    expect(files).toEqual(["src/features/background/user-token.ts"]);
    const env = readFileSync(join(root, ".env.example"), "utf8");
    expect(env).toMatch(/^BACKGROUND_JWT_PRIVATE_JWK=$/m);
    expect(env).toMatch(/^BACKGROUND_JWT_SIGNING=$/m);
    expect(env).not.toMatch(/NEXT_PUBLIC_BACKGROUND_JWT/);
    const eslint = new ESLint({ cwd: root });
    const syntax = async (code: string, file: string) =>
      (await eslint.lintText(code, { filePath: join(root, file) }))[0].messages.filter((m) => m.ruleId === "no-restricted-syntax").length;
    for (const code of [
      "export const s = process.env.BACKGROUND_JWT_PRIVATE_JWK;\n",
      'export const s = process.env["BACKGROUND_JWT_PRIVATE_JWK"];\n',
      "const { BACKGROUND_JWT_PRIVATE_JWK: s } = process.env;\nexport { s };\n",
    ]) {
      for (const file of ["src/features/x/y.ts", "src/features/jobs/run-server.ts", "src/lib/supabase/auth-forwarding-server.ts", "src/features/auth/turnstile-server.ts"]) {
        expect(await syntax(code, file), `${code} in ${file}`).toBeGreaterThan(0);
      }
    }
    const real = await eslint.lintFiles(["src/features/background/user-token.ts"]);
    expect(real.flatMap((r) => r.messages.filter((m) => m.ruleId === "no-restricted-syntax"))).toEqual([]);
  }, 120_000);
});

// IMP-04, owner (421) א (18 November 2026): proof, on the LOCAL Supabase stack only, that a background-job token signed
// ES256 with a key in STANDBY state (published in the project's keys, never used by Auth to sign sessions) is accepted by
// PostgREST and Storage, and that such a token reads nothing beyond its person (RLS still applies; another business's rows
// and another person's files stay out of reach). It also proves the negative: a token signed by a key the stack does not
// publish is refused by both.
//
// How to run (the stack is shared with the lead; this script RESTARTS it twice and puts it back as it was):
//   1. npm run stack:start   (Docker up; the CLI is pinned to 2.121.0)
//   2. BG_ES256_RESTART_OK=1 node tests/e2e/background-token-es256.mjs
//      Auth signs sessions with its own ES256 key ("current", first in the keys file); our key is a second, verify-only
//      key (key_ops ["verify"]), the local stand-in for a key imported as STANDBY. CLI 2.121.0 cannot emulate a project
//      whose sessions are still signed by the legacy HS256 secret beside an asymmetric standby key: Auth refuses to start
//      ("no signing key found") when the keys file holds no signing key. The legacy secret itself stays accepted: the
//      script also checks the HS256 token the worker signs today.
// What it does: makes throwaway P-256 keys in a scratch folder (never anything from the hosted project), copies
// supabase/ there with `[auth] signing_keys_path` added (the repo's config.toml is NOT changed, so CI and the e2e keep
// their default stack), stops the stack (data kept), starts it from the copy, runs the checks, then stops it and starts it
// again from the repo's own supabase/ folder. It creates two throwaway accounts and two businesses (names start bg-es256-).
// The real worker path was also run once against such a stack (18 November 2026): tests/e2e/background-jobs.mjs passed
// with BACKGROUND_JWT_SIGNING=es256, the standby JWK and no SUPABASE_JWT_SECRET (app rebuilt with the stack's ES256 anon key).
// It prints PASS or FAIL per step and exits non-zero on any failure. It refuses to run against anything not on this machine.
import { execFileSync } from "node:child_process";
import { createHmac, createPrivateKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = ["-y", "supabase@2.121.0"];
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const cli = (args, workdir) =>
  execFileSync("npx", [...CLI, ...args, "--workdir", workdir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600_000 });
function stackEnv(workdir) {
  const out = cli(["status", "-o", "env"], workdir);
  return Object.fromEntries(
    out
      .split("\n")
      .map((line) => line.match(/^([A-Z_0-9]+)="?(.*?)"?$/))
      .filter(Boolean)
      .map((m) => [m[1], m[2]]),
  );
}

// throwaway keys, in a scratch folder outside the repo; deleted at the end
if (process.env.BG_ES256_RESTART_OK !== "1") {
  // this script stops and restarts the shared local stack: refuse unless asked to, so no other run is cut off
  console.log("set BG_ES256_RESTART_OK=1 to allow this script to restart the local Supabase stack");
  process.exit(2);
}
const scratch = mkdtempSync(join(tmpdir(), "bg-es256-"));
// a killed run still removes the throwaway keys and puts the stack back on the repo's own config
let cleaned = false;
const emergencyCleanup = (signal) => {
  if (cleaned) return;
  cleaned = true;
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  try { cli(["stop"], join(scratch, "stack")); } catch {}
  try { cli(["start"], repo); } catch {}
  process.exit(signal === "SIGINT" ? 130 : 143);
};
process.on("SIGINT", () => emergencyCleanup("SIGINT"));
process.on("SIGTERM", () => emergencyCleanup("SIGTERM"));
const jwkOf = (kid, ops) => {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { ...privateKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig", key_ops: ops };
};
const standby = jwkOf(randomUUID(), ["verify"]);
const current = jwkOf(randomUUID(), ["sign", "verify"]);
const stranger = jwkOf(randomUUID(), ["sign", "verify"]); // never published
const keys = [current, standby];

const copy = join(scratch, "stack");
cpSync(join(repo, "supabase"), join(copy, "supabase"), { recursive: true, filter: (src) => !src.split(/[\\/]/).includes(".temp") });
const configPath = join(copy, "supabase", "config.toml");
const config = readFileSync(configPath, "utf8");
if (!/^\[auth\]$/m.test(config) || /signing_keys_path/.test(config.replace(/^#.*$/gm, ""))) throw new Error("unexpected config.toml");
writeFileSync(configPath, config.replace(/^\[auth\]$/m, '[auth]\nsigning_keys_path = "./signing_keys.json"'));
writeFileSync(join(copy, "supabase", "signing_keys.json"), JSON.stringify(keys, null, 2));

// the same header and claims as src/features/background/user-token.ts signs (its unit tests pin that shape)
const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
function backgroundToken(jwk, claims, { kid = jwk.kid, tamper = false } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: "ES256", typ: "JWT", kid })}.${b64({
    aud: "authenticated",
    sub: claims.sub,
    role: "authenticated",
    aal: claims.aal,
    session_id: claims.session_id,
    crm_background: claims.crm_background,
    iat: now,
    exp: now + 600,
  })}`;
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y }, format: "jwk" });
  let signature = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  if (tamper) signature = Buffer.from(signature.map((byte, i) => (i === 10 ? byte ^ 1 : byte)));
  return `${input}.${signature.toString("base64url")}`;
}
const decodeHeader = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[0], "base64url").toString());
const decodePayload = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());

let failed = false;
let started = false;
try {
  console.log("restarting the local stack with a current key and a standby key");
  cli(["stop"], repo);
  cli(["start"], copy);
  started = true;
  const env = stackEnv(copy);
  const API = env.API_URL;
  for (const url of [API, env.DB_URL.replace(/^postgresql:/, "http:")]) {
    if (!["localhost", "127.0.0.1"].includes(new URL(url).hostname)) throw new Error(`Refusing to run against ${url}`);
  }
  const ANON = env.ANON_KEY;
  const SERVICE = env.SERVICE_ROLE_KEY;
  const http = async (path, { token, method = "GET", body, headers = {} } = {}) => {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: { apikey: ANON, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
      body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, json, text };
  };

  // the stack publishes the standby key, and Auth does not sign with it
  const jwks = await http("/auth/v1/.well-known/jwks.json");
  const kids = (jwks.json?.keys ?? []).map((k) => k.kid);
  check("JWKS publishes the standby key", kids.includes(standby.kid), `kids ${kids.length}`);
  check("JWKS does not publish the stranger key", !kids.includes(stranger.kid));
  check("JWKS carries no private part", !(jwks.json?.keys ?? []).some((k) => "d" in k));

  // two throwaway people, each owning one business
  const run = Date.now().toString(36);
  const people = [];
  for (const who of ["a", "b"]) {
    const email = `bg-es256-${who}-${run}@example.test`;
    const password = `Es256-${randomUUID()}`;
    const made = await http("/auth/v1/admin/users", { token: SERVICE, method: "POST", body: { email, password, email_confirm: true }, headers: { apikey: SERVICE } });
    if (made.status !== 200) throw new Error(`admin create user ${made.status}`);
    const session = await http("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
    if (session.status !== 200) throw new Error(`sign in ${session.status}`);
    const access = session.json.access_token;
    const header = decodeHeader(access);
    check(`Auth signs ${who}'s session with its own key, not the standby key`, header.kid !== standby.kid && header.alg === "ES256" && header.kid === current.kid, `alg ${header.alg}`);
    const claims = decodePayload(access);
    // fixture only: the business is made by the real public.create_organization as that person (its claims set in the
    // transaction), through the local database, because the seeding of a new business can pass the API's statement
    // timeout on a stack that was just restarted
    const db = new pg.Client({ connectionString: env.DB_URL });
    await db.connect();
    let orgId;
    try {
      await db.query("begin");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, role: "authenticated", aal: claims.aal ?? "aal1" })]);
      orgId = (await db.query("select public.create_organization($1) as id", [`bg-es256-${who}-${run}`])).rows[0].id;
      await db.query("commit");
    } finally {
      await db.end();
    }
    people.push({ who, email, access, org: orgId, claims: { sub: claims.sub, aal: claims.aal ?? "aal1", session_id: claims.session_id, crm_background: randomUUID() } });
  }
  const [a, b] = people;

  // B puts an avatar in its own folder with its own session (the fixture A must not reach)
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64"));
  const bPath = `${b.claims.sub}/${randomUUID()}`;
  const bUp = await http(`/storage/v1/object/avatars/${bPath}`, { token: b.access, method: "POST", body: png, headers: { "content-type": "image/png" } });
  check("fixture: B uploads its own avatar with its session", bUp.status === 200, `status ${bUp.status}`);

  const token = backgroundToken(standby, a.claims);
  check("the background token carries alg ES256 and the standby kid", decodeHeader(token).alg === "ES256" && decodeHeader(token).kid === standby.kid);

  // PostgREST
  const orgs = await http("/rest/v1/organizations?select=id", { token });
  const orgIds = (Array.isArray(orgs.json) ? orgs.json : []).map((r) => r.id);
  check("PostgREST accepts the standby-key token", orgs.status === 200, `status ${orgs.status}`);
  check("PostgREST: it reads A's own business", orgIds.includes(a.org));
  check("PostgREST: it does not read B's business", !orgIds.includes(b.org));
  const direct = await http(`/rest/v1/organizations?select=id&id=eq.${b.org}`, { token });
  check("PostgREST: asking for B's business by id answers nothing", direct.status === 200 && Array.isArray(direct.json) && direct.json.length === 0);
  const profiles = await http(`/rest/v1/profiles?select=id&id=eq.${b.claims.sub}`, { token });
  check("PostgREST: B's profile stays hidden", profiles.status === 200 && Array.isArray(profiles.json) && profiles.json.length === 0);
  const whoami = await http("/rest/v1/rpc/org_context", { token, method: "POST", body: { p_org: a.org } });
  check("PostgREST: the token acts as A (A's own business context)", whoami.status === 200 && JSON.stringify(whoami.json ?? "").includes(a.org), `status ${whoami.status}`);
  const same = await http("/rest/v1/organizations?select=id", { token: a.access });
  check("PostgREST: the token reads exactly what A's own session reads", JSON.stringify(((same.json ?? []).map((r) => r.id)).sort()) === JSON.stringify([...orgIds].sort()));
  const foreign = await http("/rest/v1/organizations?select=id", { token: backgroundToken(stranger, a.claims) });
  check("PostgREST refuses a token from a key it does not publish", foreign.status === 401, `status ${foreign.status}`);
  const tampered = await http("/rest/v1/organizations?select=id", { token: backgroundToken(standby, a.claims, { tamper: true }) });
  check("PostgREST refuses a standby-kid token with a broken signature", tampered.status === 401, `status ${tampered.status}`);

  // Storage
  const aPath = `${a.claims.sub}/${randomUUID()}`;
  const aUp = await http(`/storage/v1/object/avatars/${aPath}`, { token, method: "POST", body: png, headers: { "content-type": "image/png" } });
  check("Storage accepts the standby-key token (A writes its own avatar)", aUp.status === 200, `status ${aUp.status}`);
  const aDown = await http(`/storage/v1/object/authenticated/avatars/${aPath}`, { token });
  check("Storage: A reads its own avatar back", aDown.status === 200, `status ${aDown.status}`);
  const into = await http(`/storage/v1/object/avatars/${b.claims.sub}/${randomUUID()}`, { token, method: "POST", body: png, headers: { "content-type": "image/png" } });
  check("Storage: A cannot write into B's folder (row-level security)", into.status >= 400 && /row-level security/i.test(into.text), `status ${into.status}`);
  const peek = await http(`/storage/v1/object/authenticated/avatars/${bPath}`, { token });
  check("Storage: A cannot read B's avatar", peek.status >= 400, `status ${peek.status}`);
  const list = await http("/storage/v1/object/list/avatars", { token, method: "POST", body: { prefix: b.claims.sub } });
  check("Storage: listing B's folder answers nothing", list.status === 200 && Array.isArray(list.json) && list.json.length === 0, `status ${list.status}`);
  const sForeign = await http(`/storage/v1/object/authenticated/avatars/${aPath}`, { token: backgroundToken(stranger, a.claims) });
  check("Storage refuses a token from a key it does not publish", sForeign.status >= 400 && /unauthorized|jw[st]|signature|token|key/i.test(sForeign.text) && !/row-level/i.test(sForeign.text), `status ${sForeign.status} ${sForeign.text.slice(0, 160)}`);
  const sTamper = await http(`/storage/v1/object/authenticated/avatars/${aPath}`, { token: backgroundToken(standby, a.claims, { tamper: true }) });
  check("Storage refuses a standby-kid token with a broken signature", sTamper.status >= 400 && /jw[st]|signature|token/i.test(sTamper.text) && !/row-level/i.test(sTamper.text), `status ${sTamper.status}`);
  // the legacy HS256 token the worker signs today keeps working beside it (the switch can stay off, or be turned back)
  const now = Math.floor(Date.now() / 1000);
  const hsInput = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ aud: "authenticated", sub: a.claims.sub, role: "authenticated", aal: a.claims.aal, session_id: a.claims.session_id, crm_background: a.claims.crm_background, iat: now, exp: now + 600 })}`;
  const hs = `${hsInput}.${createHmac("sha256", env.JWT_SECRET).update(hsInput).digest("base64url")}`;
  const hsRest = await http("/rest/v1/organizations?select=id", { token: hs });
  // info only: with signing_keys_path, CLI 2.121.0 hands PostgREST the asymmetric public keys only, so the legacy secret
  // is not accepted there locally; the hosted project keeps the legacy secret verifiable until the owner revokes it
  console.log(`info: PostgREST and the legacy HS256 token on this local stack: status ${hsRest.status} ${hsRest.json?.code ?? ""}`);
  const anonRest = await http("/rest/v1/rpc/plans_public", { token: ANON, method: "POST", body: {} });
  console.log(`info: the stack's anon key (alg ${decodeHeader(ANON).alg}) at PostgREST: status ${anonRest.status}`);
  const hsStorage = await http(`/storage/v1/object/authenticated/avatars/${aPath}`, { token: hs });
  check("Storage still accepts the HS256 background token", hsStorage.status === 200, `status ${hsStorage.status}`);
  const legacy = await http("/rest/v1/organizations?select=id", { token: a.access });
  check("the person's own session still works beside the standby key", legacy.status === 200);
} catch (error) {
  failed = true;
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
} finally {
  try {
    if (started) cli(["stop"], copy);
    cli(["start"], repo);
    console.log("the local stack was started again from the repo's supabase/ folder");
  } catch (error) {
    failed = true;
    console.log(`FAIL restoring the stack: ${error instanceof Error ? error.message : String(error)}`);
  }
  rmSync(scratch, { recursive: true, force: true });
  cleaned = true;
}

const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} passed${failed ? ", stopped early" : ""}`);
process.exit(bad || failed ? 1 : 0);

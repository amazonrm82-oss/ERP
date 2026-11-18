import "server-only";

import { createHmac, createPrivateKey, createPublicKey, sign as signWith, type KeyObject } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { AGREEMENT_VERSION } from "@/features/legal/agreement";
import type { ClaimedJob } from "@/features/jobs/registry";
import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";
import { logEvent } from "@/lib/log";

import { parseTokenAnswer, USER_TOKEN_SECONDS, type TokenClaims } from "./rules";

// IMP-04 (owner (155) א and (160) א): the background job writes with the rights of the person who ordered it, never as
// an admin. THIS FILE IS THE ONLY READER OF SUPABASE_JWT_SECRET (the project's JWT secret, set by the owner in Vercel; as
// strong as the service key). Lint refuses the name anywhere else, and only the worker (src/features/jobs/run-server.ts)
// and its handlers may import the token source or the user client (eslint.config.mjs).
// No caller hands claims in (review 1): the token source takes only the worker's service client, the job id and its lease,
// and asks public.background_job_token itself before EVERY signing (the first one and each refresh). That function checks
// the person again (an active member, the ordering session still open and not run out, the current legal agreement
// signed, the right of the work judged with their own claims), logs the signing in app.platform_log, and answers the
// claims: sub, role 'authenticated', the ordering session's aal (the lower of the order's and the session's now) and id,
// crm_background (the order, which the audit records), and the lease's end. The token lives 10 minutes, never past the
// lease (review 2). Every write then goes through PostgREST and Storage exactly like the browser's.
// Owner (421) א, 18 November 2026: the token may instead be signed ES256 with the private half of a P-256 key the owner
// imported into Supabase as a STANDBY signing key (Supabase keeps signing sessions with its own key; PostgREST and Storage
// accept every key of the project's JWKS). THIS FILE IS ALSO THE ONLY READER OF BACKGROUND_JWT_PRIVATE_JWK (a JSON JWK:
// kty EC, crv P-256, d, x, y, kid; as strong as the JWT secret). ES256 is used only while BACKGROUND_JWT_SIGNING is
// "es256"; unset, empty or "hs256" = HS256 exactly as before. Any other switch value, or "es256" with a missing or bad key,
// signs nothing (fail closed, never HS256 instead) and writes one redacted line, background.token_key_invalid, naming
// only the reason code.

/** Raised when the database refused the claims (the job and the order were already ended there). */
export class TokenRefused extends Error {
  constructor(readonly reason: string) {
    super(`token refused: ${reason}`);
    this.name = "TokenRefused";
  }
}

function userTokenSecret(): string | null {
  const secret = process.env.SUPABASE_JWT_SECRET?.trim();
  return secret && secret.length >= 32 ? secret : null;
}

type Signer = { alg: "HS256"; secret: string } | { alg: "ES256"; key: KeyObject; kid: string };
type SignerState = { ok: true; signer: Signer } | { ok: false; reason: "not_configured" | "key_invalid" | "signing_unknown" };

const B64URL = /^[A-Za-z0-9_-]+$/;
const KID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The standby ES256 key from its JWK text, or null when it is not a P-256 private key with a kid (never says why). */
function standbyKey(text: string | undefined): { key: KeyObject; kid: string } | null {
  if (!text || text.length > 4096) return null;
  try {
    const jwk: unknown = JSON.parse(text);
    if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) return null;
    const { kty, crv, d, x, y, kid, alg, use } = jwk as Record<string, unknown>;
    if (kty !== "EC" || crv !== "P-256") return null;
    if (alg !== undefined && alg !== "ES256") return null;
    if (use !== undefined && use !== "sig") return null;
    if (typeof kid !== "string" || !KID.test(kid)) return null;
    if (typeof d !== "string" || typeof x !== "string" || typeof y !== "string") return null;
    if (![d, x, y].every((part) => B64URL.test(part) && Buffer.from(part, "base64url").length === 32)) return null;
    const key = createPrivateKey({ key: { kty, crv, d, x, y }, format: "jwk" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") return null;
    // the public half the JWK states must be the one d makes (a pasted mix of two keys is refused)
    const own = createPublicKey(key).export({ format: "jwk" });
    if (own.x !== x || own.y !== y) return null;
    return { key, kid };
  } catch {
    return null;
  }
}

let invalidLogged = false;

/** The signer the environment asks for; a refusal is logged once per process, by reason code only. */
function userTokenSigner(): SignerState {
  const mode = (process.env.BACKGROUND_JWT_SIGNING ?? "").trim().toLowerCase();
  let state: SignerState;
  if (mode === "" || mode === "hs256") {
    const secret = userTokenSecret();
    return secret ? { ok: true, signer: { alg: "HS256", secret } } : { ok: false, reason: "not_configured" };
  } else if (mode === "es256") {
    const standby = standbyKey(process.env.BACKGROUND_JWT_PRIVATE_JWK?.trim());
    state = standby ? { ok: true, signer: { alg: "ES256", ...standby } } : { ok: false, reason: "key_invalid" };
  } else {
    state = { ok: false, reason: "signing_unknown" };
  }
  if (!state.ok && !invalidLogged) {
    invalidLogged = true;
    logEvent("error", "background.token_key_invalid", { reason: state.reason });
  }
  return state;
}

/** True when the worker can act for a person (the import wizard and the export page offer the background path). */
export function backgroundJobsReady(): boolean {
  return userTokenSigner().ok && getSupabaseEnv() !== null;
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** Module-private: a token with exactly the database's claims, until `expSeconds`, HS256 or ES256 by the signer. */
function signUserToken(claims: TokenClaims, signer: Signer, iatSeconds: number, expSeconds: number): string {
  const header = base64url(JSON.stringify(signer.alg === "ES256" ? { alg: "ES256", typ: "JWT", kid: signer.kid } : { alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      aud: "authenticated",
      sub: claims.sub,
      role: "authenticated",
      aal: claims.aal,
      session_id: claims.session_id,
      crm_background: claims.crm_background,
      iat: iatSeconds,
      exp: expSeconds,
    }),
  );
  const input = `${header}.${payload}`;
  const signature =
    signer.alg === "ES256"
      ? signWith("sha256", Buffer.from(input), { key: signer.key, dsaEncoding: "ieee-p1363" }).toString("base64url")
      : createHmac("sha256", signer.secret).update(input).digest("base64url");
  return `${input}.${signature}`;
}

/** Signing again this long before the token runs out (each time after asking the database again). */
const REFRESH_BEFORE_SECONDS = 60;

/** The part of the worker's service client the token source uses: the one function it calls. */
type TokenCheckClient = Pick<SupabaseClient<Database>, "rpc">;

export type BackgroundTokenSource = {
  /** The person's current token; asks the database again before signing a new one. */
  token(): Promise<string>;
  /** The database's refusal, once one was answered (the job and the order were ended there). */
  refused(): string | null;
};

/**
 * The person's token for one background job, made only from public.background_job_token's answer for this job and lease
 * (never from claims a caller supplies). A refusal raises TokenRefused, and every later call raises it again.
 */
export function createBackgroundTokenSource(
  service: TokenCheckClient,
  job: Pick<ClaimedJob, "id" | "lease" | "payload">,
  options: { now?: () => number } = {},
): BackgroundTokenSource {
  const now = options.now ?? Date.now;
  const requestId = typeof job.payload.request_id === "string" ? job.payload.request_id : "";
  const userId = typeof job.payload.user_id === "string" ? job.payload.user_id : "";
  let current: string | null = null;
  let expiresAt = 0;
  let refusal: string | null = null;
  const refuse = (reason: string): never => {
    refusal = reason;
    throw new TokenRefused(reason);
  };
  return {
    refused: () => refusal,
    token: async () => {
      if (refusal) throw new TokenRefused(refusal);
      const seconds = Math.floor(now() / 1000);
      if (current && seconds < expiresAt - REFRESH_BEFORE_SECONDS) return current;
      const signing = userTokenSigner();
      if (!signing.ok) return refuse(signing.reason);
      const { data, error } = await service.rpc("background_job_token", { p_job: job.id, p_lease: job.lease, p_legal_version: AGREEMENT_VERSION });
      if (error) throw new Error("token check failed");
      const answer = parseTokenAnswer(data, requestId);
      if (!answer.ok) return refuse(answer.reason);
      if (answer.claims.sub !== userId) return refuse("person_changed");
      // review 2: never past the lease's end
      const exp = Math.min(seconds + USER_TOKEN_SECONDS, answer.lockedUntilSeconds);
      if (exp <= seconds) return refuse("stale");
      current = signUserToken(answer.claims, signing.signer, seconds, exp);
      expiresAt = exp;
      return current;
    },
  };
}

/** A client that acts as the person through their short-lived token (no session kept). */
export function createUserClient(source: BackgroundTokenSource): SupabaseClient<Database> | null {
  const env = getSupabaseEnv();
  if (!env) return null;
  return createClient<Database>(env.url, env.anonKey, { accessToken: () => source.token() });
}

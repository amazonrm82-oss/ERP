import "server-only";

import { createHmac } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { AGREEMENT_VERSION } from "@/features/legal/agreement";
import type { ClaimedJob } from "@/features/jobs/registry";
import type { Database } from "@/lib/database.types";
import { getSupabaseEnv } from "@/lib/env";

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

/** True when the worker can act for a person (the import wizard and the export page offer the background path). */
export function backgroundJobsReady(): boolean {
  return userTokenSecret() !== null && getSupabaseEnv() !== null;
}

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** Module-private: an HS256 token with exactly the database's claims, until `expSeconds`. */
function signUserToken(claims: TokenClaims, secret: string, iatSeconds: number, expSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
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
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
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
      const secret = userTokenSecret();
      if (!secret) return refuse("not_configured");
      const { data, error } = await service.rpc("background_job_token", { p_job: job.id, p_lease: job.lease, p_legal_version: AGREEMENT_VERSION });
      if (error) throw new Error("token check failed");
      const answer = parseTokenAnswer(data, requestId);
      if (!answer.ok) return refuse(answer.reason);
      if (answer.claims.sub !== userId) return refuse("person_changed");
      // review 2: never past the lease's end
      const exp = Math.min(seconds + USER_TOKEN_SECONDS, answer.lockedUntilSeconds);
      if (exp <= seconds) return refuse("stale");
      current = signUserToken(answer.claims, secret, seconds, exp);
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

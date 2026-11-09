import { decryptSecret, SecretError, type SecretKey } from "@/features/integrations/crypto";
import { rateLimitedJson } from "@/lib/public-rate-limit";
import { bearerSecretMatches } from "@/lib/shared-secret";

import { finishLeadFrom, type FinishLead } from "./fields";
import type { MetaGraphProvider } from "./graph/types";
import { metaChallenge, metaSignatureValid } from "./signature";
import { withTimeout } from "./timeout";
import { leadgenWebhook } from "./webhook-payload";

/**
 * CAP-11 (owner (126) א): the Meta Lead Ads webhook and its sweep, with the database, the Graph provider and the keys
 * handed in (webhook-server.ts binds them), so the order of the checks can be tested without a database.
 *
 * GET  /api/meta/leads        answers hub.challenge only when hub.verify_token equals META_VERIFY_TOKEN; reads nothing.
 * POST /api/meta/leads        refused (401) BEFORE the database is reached, and without logging the body, unless
 *                             X-Hub-Signature-256 is the HMAC of the raw body with META_APP_SECRET; then records the lead
 *                             ids (meta_lead_receive), answers Meta, and only then fetches up to 5 new ones
 *                             (meta_lead_claim / _finish, through `defer`).
 * POST /api/meta/leads/sweep  woken by the database with the shared secret; fetches what is due again (a failure earlier).
 *
 * The page token is decrypted only for the one Graph call, never logged, never returned. Nothing here writes a log line
 * with a body, a token, a lead's details or a ciphertext.
 */

export type ReceiveAnswer = { status: "ok" | "rate_limited" | "unknown_page"; new?: number; arrivals?: string[] };
export type Claimed = {
  arrival: string;
  lease: string;
  meta_lead_id: string;
  organization_id: string;
  integration_id: string;
  page_id: string;
  ciphertext: string;
};

export type MetaLeadsDb = {
  receive(pageId: string, leads: { id: string; form_id: string | null }[]): Promise<ReceiveAnswer>;
  claim(limit: number, ids: string[] | null): Promise<Claimed[]>;
  finish(arrival: string, lease: string, lead: FinishLead | null, error: string | null): Promise<string>;
};

export type MetaLeadsDeps = {
  env: Record<string, string | undefined>;
  /** made only after every check that needs no database passed */
  db: () => MetaLeadsDb | null;
  provider: MetaGraphProvider | null;
  keys: SecretKey[];
  /**
   * Review finding 4: work to run after Meta has its answer (next/server `after`), so a slow Graph never delays the
   * webhook's reply. Tests run it at once.
   */
  defer: (work: () => Promise<void>) => void;
};

/** The largest body read (Meta sends small JSON; a bigger one is refused before it is read in full). */
export const MAX_BODY_BYTES = 256 * 1024;
/**
 * Leads the webhook fetches after answering Meta (review finding 4): at most 5, each within PROVIDER_TIMEOUT_MS, so the batch
 * ends well inside the two-minute lease; the rest waits for the sweep.
 */
const DEFERRED_FETCHES = 5;
/** The sweep's claim per round (each fetch within PROVIDER_TIMEOUT_MS: a round of 5 ends inside the lease). */
const SWEEP_BATCH = 5;
/** The sweep's rounds of claims per wake. */
const SWEEP_ROUNDS = 5;

const noStore = { "Cache-Control": "no-store" };
const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: noStore });

export function verifyRoute(request: Request, deps: Pick<MetaLeadsDeps, "env">): Response {
  const token = deps.env.META_VERIFY_TOKEN?.trim();
  if (!token) return new Response("not configured", { status: 503, headers: noStore });
  const challenge = metaChallenge(new URL(request.url).searchParams, token);
  if (challenge === null) return new Response("forbidden", { status: 403, headers: noStore });
  return new Response(challenge, { status: 200, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
}

async function readBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Fetches claimed leads from the Graph API and hands each outcome to the database. Answers how many ended. */
export async function fetchClaimed(claimed: Claimed[], db: MetaLeadsDb, provider: MetaGraphProvider, keys: SecretKey[]): Promise<number> {
  let ended = 0;
  for (const item of claimed) {
    let token: string;
    try {
      token = decryptSecret(item.ciphertext, keys, { organizationId: item.organization_id, integrationId: item.integration_id, externalId: item.page_id });
    } catch (error) {
      if (!(error instanceof SecretError)) throw error;
      await db.finish(item.arrival, item.lease, null, "secret_unreadable");
      continue;
    }
    const result = await withTimeout(provider.fetchLead(item.meta_lead_id, token, item.page_id), { ok: false as const, code: "graph_unavailable" as const });
    const outcome = result.ok
      ? await db.finish(item.arrival, item.lease, finishLeadFrom(result.lead), null)
      : await db.finish(item.arrival, item.lease, null, result.code);
    if (outcome === "accepted" || outcome === "duplicate" || outcome === "refused") ended += 1;
  }
  return ended;
}

export async function webhookRoute(request: Request, deps: MetaLeadsDeps): Promise<Response> {
  const appSecret = deps.env.META_APP_SECRET?.trim();
  if (!appSecret) return json(503, { error: "not configured" });
  const body = await readBody(request);
  if (body === null) return json(413, { error: "too large" });
  // the signature first: nothing below runs, and the body is never logged, unless it is Meta's
  if (!metaSignatureValid(body, request.headers.get("x-hub-signature-256"), appSecret)) return json(401, { error: "unauthorized" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json(400, { error: "invalid" });
  }
  const pages = leadgenWebhook(parsed);
  if (pages === null) return json(400, { error: "invalid" });
  if (pages.length === 0) return json(200, { ok: true });

  const db = deps.db();
  if (!db) return json(503, { error: "not configured" });
  const arrivals: string[] = [];
  let limited = false;
  try {
    for (const page of pages) {
      const answer = await db.receive(page.pageId, page.leads);
      if (answer.status === "rate_limited") limited = true;
      arrivals.push(...(answer.arrivals ?? []));
    }
  } catch {
    // Meta sends it again; nothing of the body is logged
    return json(500, { error: "try again" });
  }

  // fetched after Meta has its answer, when a provider and the key are there; anything that fails waits for the sweep
  const provider = deps.provider;
  if (provider && deps.keys.length > 0 && arrivals.length > 0) {
    deps.defer(async () => {
      try {
        const claimed = await db.claim(DEFERRED_FETCHES, arrivals.slice(0, DEFERRED_FETCHES));
        await fetchClaimed(claimed, db, provider, deps.keys);
      } catch {
        // recorded already; the sweep fetches it
      }
    });
  }
  // a connection over its hourly limit: Meta tries the rest again later (what was taken is not taken twice)
  if (limited) return rateLimitedJson({ ok: false });
  return json(200, { ok: true });
}

export async function sweepRoute(request: Request, deps: MetaLeadsDeps): Promise<Response> {
  const secret = deps.env.PUSH_DISPATCH_SECRET?.trim();
  if (!secret) return json(503, { error: "not configured" });
  if (!bearerSecretMatches(request.headers.get("authorization"), secret)) return json(401, { error: "unauthorized" });
  // without a provider or the key nothing is claimed: the arrivals keep waiting, uncounted
  if (!deps.provider || deps.keys.length === 0) return json(503, { error: "not configured" });
  const db = deps.db();
  if (!db) return json(503, { error: "not configured" });
  let claimedTotal = 0;
  let ended = 0;
  try {
    for (let round = 0; round < SWEEP_ROUNDS; round += 1) {
      const claimed = await db.claim(SWEEP_BATCH, null);
      if (claimed.length === 0) break;
      claimedTotal += claimed.length;
      ended += await fetchClaimed(claimed, db, deps.provider, deps.keys);
    }
  } catch {
    return json(500, { error: "sweep failed" });
  }
  return json(200, { claimed: claimedTotal, ended });
}

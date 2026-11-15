import "server-only";

import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { markNotFound } from "@/lib/public-not-found";
import { RATE_LIMITED_TEXT, rateLimitedJson, rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { DIGEST_STOP_TEXTS, DIGEST_STOP_TOKEN } from "./stop";

// USR-11 / WAB-03 (owner (377) ב; the approved pattern for public secret-link pages, CLAUDE.md hard rule 5): the daily summary's
// one-click stop link reads and writes only through public.digest_stop() (security definer, service_role only), which checks the
// token, limits per sender and per link, and does only this: switches the person's summary off in that business, once. No table is
// reached directly; no cookies, no visitor id. The sender's IP reaches the database only as the keyed hash of FXS-11 (scope
// "digest"). The answer names only the business's display name.

export type DigestStopStatus = "active" | "stopped" | "used";

export type DigestStopPage = { status: DigestStopStatus; business: string } | "not-found" | "rate-limited" | "not-configured";

type Answer = { kind: "ok"; status: DigestStopStatus; business: string } | { kind: "not-found" } | { kind: "rate-limited" } | { kind: "not-configured" };

async function call(token: string, ip: string | null, stop: boolean): Promise<Answer> {
  if (!DIGEST_STOP_TOKEN.test(token)) return { kind: "not-found" };
  const service = createServiceClient();
  if (!service) return { kind: "not-configured" };
  const { data, error } = await service.rpc("digest_stop", { p_token: token, p_ip_hash: keyedIpHash(ip, "digest") ?? undefined, p_stop: stop });
  if (error) throw new Error(`digest_stop failed: ${error.code}`);
  const r = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;
  if (r.rate_limited === true) return { kind: "rate-limited" };
  if (r.status === "not_found") return { kind: "not-found" };
  if ((r.status === "active" || r.status === "stopped" || r.status === "used") && typeof r.business === "string") {
    return { kind: "ok", status: r.status, business: r.business };
  }
  // OPS-02 review: a malformed answer is an error, never "not found"
  throw new Error("digest_stop answered an unexpected shape");
}

/** The page: reads only (a link scanner that opens the link stops nothing). */
export async function getDigestStopPage(token: string, ip: string | null): Promise<DigestStopPage> {
  const answer = await call(token, ip, false);
  if (answer.kind === "ok") return { status: answer.status, business: answer.business };
  return answer.kind;
}

const json = (status: number, body: Record<string, unknown>) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
const text = (status: number, message: string) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });

/**
 * POST /api/forms/digest-stop/<token>: the page's button (JSON) or a mail program's one-click stop (RFC 8058,
 * application/x-www-form-urlencoded with List-Unsubscribe=One-Click). The body is read only to tell the two apart.
 */
export async function handleDigestStop(request: Request, token: string): Promise<Response> {
  const oneClick = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  const notFound = () => markNotFound(oneClick ? text(404, DIGEST_STOP_TEXTS.notFound) : json(404, { ok: false, message: DIGEST_STOP_TEXTS.notFound }));
  if (!DIGEST_STOP_TOKEN.test(token)) return notFound();
  if (Number(request.headers.get("content-length") ?? 0) > 2048) return oneClick ? text(413, DIGEST_STOP_TEXTS.error) : json(413, { ok: false, message: DIGEST_STOP_TEXTS.error });
  let raw = "";
  try {
    raw = (await request.text()).slice(0, 2048);
  } catch {
    raw = "";
  }
  if (oneClick && !new URLSearchParams(raw).has("List-Unsubscribe")) return text(400, DIGEST_STOP_TEXTS.error);
  let answer: Answer;
  try {
    answer = await call(token, clientIp(request.headers), true);
  } catch {
    await serverLog("error", "digest.stop_failed", {});
    return oneClick ? text(500, DIGEST_STOP_TEXTS.error) : json(500, { ok: false, message: DIGEST_STOP_TEXTS.error });
  }
  if (answer.kind === "not-found") return notFound();
  if (answer.kind === "rate-limited") return oneClick ? rateLimitedText(RATE_LIMITED_TEXT) : rateLimitedJson({ ok: false, message: RATE_LIMITED_TEXT });
  if (answer.kind === "not-configured") return oneClick ? text(503, DIGEST_STOP_TEXTS.notConfigured) : json(503, { ok: false, message: DIGEST_STOP_TEXTS.notConfigured });
  // a used link whose summary was switched on again changes nothing, and says so
  if (answer.status === "used") return oneClick ? text(200, DIGEST_STOP_TEXTS.used) : json(200, { ok: false, message: DIGEST_STOP_TEXTS.used });
  return oneClick ? text(200, DIGEST_STOP_TEXTS.stopped) : json(200, { ok: true });
}

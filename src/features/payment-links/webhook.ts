// LNK-04, wave 3 use (2) of hard rule 5: the payment provider's webhook, one route per provider. Pure: the provider and the
// database call come in through `deps` (webhook-server.ts gives the service_role one). The provider adapter's verifyWebhook
// is checked BEFORE any database call; an invalid signature answers 401 with no detail, and the body is never logged (it may
// hold the payer's details at a real provider). Log lines carry codes only.

import type { PaymentProvider, PaymentWebhookEvent } from "./providers/types";

export const PAYMENT_WEBHOOK_MAX_BYTES = 64 * 1024;

export type PaymentWebhookDb = { record(provider: string, event: Record<string, unknown>): Promise<unknown> };
export type PaymentWebhookLog = (event: string, fields: { status?: string; reason?: string }) => void;
export type PaymentWebhookDeps = {
  provider: () => PaymentProvider | null;
  db: () => PaymentWebhookDb | null;
  log: PaymentWebhookLog;
};

const noStore = { "Cache-Control": "no-store" };
const json = (status: number, body: Record<string, unknown>, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...noStore, ...extra } });

async function readText(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > PAYMENT_WEBHOOK_MAX_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PAYMENT_WEBHOOK_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** The event as the database takes it: ids and codes only. */
export function webhookEventRow(event: PaymentWebhookEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    provider_link_id: event.providerLinkId,
    status: event.status,
    paid_agorot: event.paidAgorot,
    currency: event.currency,
    provider_payment_id: event.providerPaymentId,
    installments: event.installments,
  };
}

export async function paymentWebhookRoute(request: Request, providerCode: string, deps: PaymentWebhookDeps): Promise<Response> {
  const provider = deps.provider();
  // no provider here, or not this one: as if the route did not exist
  if (!provider || provider.code !== providerCode) return json(404, { error: "not found" });
  const body = await readText(request);
  if (body === null) return json(413, { error: "too large" });
  let verdict: Awaited<ReturnType<PaymentProvider["verifyWebhook"]>>;
  try {
    verdict = await provider.verifyWebhook({ headers: request.headers, body });
  } catch {
    verdict = { ok: false };
  }
  if (!verdict.ok) {
    deps.log("payments.webhook_refused", { reason: "signature" });
    return json(401, { error: "unauthorized" });
  }
  const db = deps.db();
  if (!db) return json(503, { error: "unavailable" }, { "Retry-After": "60" });
  let answer: unknown;
  try {
    answer = await db.record(provider.code, webhookEventRow(verdict.event));
  } catch {
    deps.log("payments.webhook_failed", { reason: "database" });
    return json(503, { error: "unavailable" }, { "Retry-After": "60" });
  }
  const status = answer && typeof answer === "object" && !Array.isArray(answer) ? (answer as Record<string, unknown>).status : undefined;
  if (status === "busy") return json(503, { error: "busy" }, { "Retry-After": "60" });
  if (status === "invalid") return json(400, { error: "invalid" });
  if (typeof status !== "string") return json(503, { error: "unavailable" }, { "Retry-After": "60" });
  deps.log("payments.webhook", { status });
  return json(200, { ok: true });
}

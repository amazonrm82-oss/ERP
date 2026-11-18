import { inforuSecretMatches } from "@/features/messaging/providers/inforu";

// SMS-05 (owner (318) א), wave 3 use (2): InforU's delivery reports and replies. Pure: the database calls come in through
// `db` (webhook-server.ts gives the service_role ones). The secret (the adapter's webhook secret, the last path segment;
// InforU signs neither callback) is checked timing-safe BEFORE the body is read; a wrong one answers 404 and nothing is read,
// kept or logged. The body is never logged: it holds the customer's number and the message text.
// Formats (InforU's public API documentation, https://apidoc.inforu.co.il/, "Delivery Notification / Push option using json"
// and "Receiving SMS / Push Option using json"):
//   delivery: [{"InforuId", "PhoneNumber", "Status": 2 delivered | -2 not delivered | -4 blocked by InforU | 6 clicked,
//               "StatusDescription", "CustomerMessageId", ...}]  (an array; one object is accepted too)
//             SMS-05b (live incident of 18 November 2026): the documentation says "To configure push DLR in json format,
//             contact the support department", so an account without that setting gets InforU's default push (SMS API 6.1,
//             https://www.inforu.co.il/wp-content/uploads/2020/12/SMS_API-6.1.pdf, page 13): an HTTP POST "with parameters"
//             PhoneNumber=...&Network=...&Status=2&StatusDescription=Delivered&ProjectId=...&CustomerMessageId=...&...
//             The status route takes both: a body that starts with [ or { is JSON, any other body is form parameters, and an
//             empty body reads the same parameters from the URL's query (the documentation does not say which of the two).
//   inbound:  {"CustomerId", "ProjectId", "Data": [{"Channel": "SMS_MO", "Type": "PhoneNumber", "Value": "05...",
//              "Keyword", "Message", "ShortCode", ...}]}

export const INFORU_MAX_BODY_BYTES = 256 * 1024;
const MAX_DELIVERY_ITEMS = 500;
const MAX_INBOUND_ITEMS = 50;

export type DeliveryItem = { id: string; status: "delivered" | "failed"; code?: string };
export type InboundItem = { phone: string; body: string };

export type InforuWebhookDb = {
  deliveryStatus(items: DeliveryItem[]): Promise<unknown>;
  inboundReply(item: InboundItem): Promise<unknown>;
};
export type WebhookLog = (event: string, fields: { count?: number; status?: string; reason?: string }) => void;

const noStore = { "Cache-Control": "no-store" };
const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: noStore });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function readText(request: Request): Promise<{ ok: true; value: string } | { ok: false; status: number }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > INFORU_MAX_BODY_BYTES) return { ok: false, status: 413 };
  // SMS-05b: no body reads as an empty text (the delivery report may carry its parameters in the query)
  if (!request.body) return { ok: true, value: "" };
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > INFORU_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false, status: 413 };
    }
    parts.push(value);
  }
  return { ok: true, value: Buffer.concat(parts).toString("utf8") };
}

async function readJson(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  const text = await readText(request);
  if (!text.ok) return text;
  try {
    return { ok: true, value: JSON.parse(text.value) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

/** One parameter list (form body or query) as one report object; null when it names no report field. */
function paramsReport(params: URLSearchParams): Record<string, string> | null {
  if (!params.has("CustomerMessageId") && !params.has("Status")) return null;
  const out: Record<string, string> = {};
  for (const key of ["CustomerMessageId", "Status"]) {
    const value = params.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/**
 * SMS-05b: a delivery report in either of InforU's push formats (see the header): JSON, or form parameters in the body, or
 * (an empty body) in the URL's query. Only CustomerMessageId and Status are taken from form parameters; nothing else is kept.
 */
export async function readDeliveryReport(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> {
  const text = await readText(request);
  if (!text.ok) return text;
  const body = text.value.trim();
  if (body.startsWith("[") || body.startsWith("{")) {
    try {
      return { ok: true, value: JSON.parse(body) as unknown };
    } catch {
      return { ok: false, status: 400 };
    }
  }
  const report = body !== "" ? paramsReport(new URLSearchParams(body)) : paramsReport(new URL(request.url).searchParams);
  return report ? { ok: true, value: report } : { ok: false, status: 400 };
}

/** The delivery report's items we keep: our job id (CustomerMessageId) and delivered / not delivered; clicks are left out. */
export function deliveryItems(value: unknown): DeliveryItem[] {
  const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const out: DeliveryItem[] = [];
  for (const row of list.slice(0, MAX_DELIVERY_ITEMS)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = typeof r.CustomerMessageId === "string" ? r.CustomerMessageId.trim().toLowerCase() : "";
    const status = typeof r.Status === "number" ? r.Status : typeof r.Status === "string" ? Number(r.Status) : NaN;
    if (!UUID.test(id)) continue;
    if (status === 2) out.push({ id, status: "delivered" });
    else if (status === -2 || status === -4) out.push({ id, status: "failed", code: status === -2 ? "inforu_undelivered" : "inforu_blocked" });
  }
  return out;
}

/** The replies of the inbound post: SMS only, a number and a text. */
export function inboundItems(value: unknown): InboundItem[] {
  const data = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).Data : undefined;
  if (!Array.isArray(data)) return [];
  const out: InboundItem[] = [];
  for (const row of data.slice(0, MAX_INBOUND_ITEMS)) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (r.Channel !== undefined && r.Channel !== "SMS_MO") continue;
    if (typeof r.Value !== "string" || typeof r.Message !== "string") continue;
    if (r.Value.length > 32 || r.Message.length > 1000) continue;
    out.push({ phone: r.Value, body: r.Message });
  }
  return out;
}

const field = (data: unknown, key: string): unknown => (data && typeof data === "object" ? (data as Record<string, unknown>)[key] : undefined);
const rateLimited = (data: unknown) => field(data, "rate_limited") === true;
const positive = (data: unknown, key: string) => typeof field(data, key) === "number" && (field(data, key) as number) > 0;
// review (5), (6): InforU posts again after a 5xx, so a limit or a report that came too early answers 503, never 429
const tryLater = () => Response.json({ ok: false }, { status: 503, headers: { ...noStore, "Retry-After": "60" } });

export async function inforuStatusRoute(request: Request, secret: string, deps: { db: () => InforuWebhookDb | null; log: WebhookLog; env?: Record<string, string | undefined> }) {
  if (!inforuSecretMatches(secret, deps.env)) return json(404, { error: "not found" });
  // RVW-101: the service-key client is made only after the secret in the path passed
  const db = deps.db();
  if (!db) return json(503, { error: "not configured" });
  const body = await readDeliveryReport(request);
  if (!body.ok) {
    // SMS-05b: counts-only, so a report in a format we do not read is seen in the logs (never the body)
    deps.log("sms.inforu.status_unreadable", { reason: body.status === 413 ? "too_large" : "format" });
    return json(body.status, { error: "bad request" });
  }
  const items = deliveryItems(body.value);
  if (items.length === 0) {
    // SMS-05b: a report that named none of our messages (or only clicks) is counted in the logs, never kept
    const rows = Array.isArray(body.value) ? body.value.length : 1;
    if (rows > 0) deps.log("sms.inforu.status_ignored", { count: rows });
    return json(200, { ok: true });
  }
  try {
    const answer = await db.deliveryStatus(items);
    if (rateLimited(answer)) {
      deps.log("sms.inforu.status_limited", { count: items.length, reason: "rate_limited" });
      return tryLater();
    }
    deps.log("sms.inforu.status", { count: items.length });
    // review (6): a report for a job whose message row is not written yet: InforU sends it again
    if (positive(answer, "pending")) return tryLater();
    return json(200, { ok: true });
  } catch {
    deps.log("sms.inforu.status_failed", { count: items.length });
    return json(500, { error: "failed" });
  }
}

export async function inforuInboundRoute(request: Request, secret: string, deps: { db: () => InforuWebhookDb | null; log: WebhookLog; env?: Record<string, string | undefined> }) {
  if (!inforuSecretMatches(secret, deps.env)) return json(404, { error: "not found" });
  // RVW-101: the service-key client is made only after the secret in the path passed
  const db = deps.db();
  if (!db) return json(503, { error: "not configured" });
  const body = await readJson(request);
  if (!body.ok) return json(body.status, { error: "bad request" });
  const items = inboundItems(body.value);
  let limited = 0;
  try {
    for (const item of items) {
      const answer = await db.inboundReply(item);
      if (rateLimited(answer) || positive(answer, "limited")) limited += 1;
    }
  } catch {
    deps.log("sms.inforu.inbound_failed", { count: items.length });
    return json(500, { error: "failed" });
  }
  deps.log("sms.inforu.inbound", { count: items.length });
  if (limited > 0) {
    // counts only; InforU posts again, and a repeated opt-out changes nothing already written
    deps.log("sms.inforu.inbound_limited", { count: limited, reason: "rate_limited" });
    return tryLater();
  }
  return json(200, { ok: true });
}

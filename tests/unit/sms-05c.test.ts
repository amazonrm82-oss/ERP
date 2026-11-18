import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { bodySizeBucket, inforuStatusRoute, mediaTypeOf, type InforuWebhookDb } from "@/features/inforu-callbacks/webhook";
import type { ClaimedJob } from "@/features/jobs/registry";
import { clearFakeSentMessages, createFakeProvider, fakeSentMessages } from "@/features/messaging/providers/fake";
import { SERVICE_MESSAGE_TYPES } from "@/features/messaging/providers/types";
import { createSendHandler, MARKETING_SMS_OFF_CODE, marketingSmsEnabled } from "@/features/messaging/send-handler";
import { REFUSED } from "@/features/messaging/timeline-entry";
import { LOG_FIELDS, logRecord, loggableFieldName } from "@/lib/log";

// SMS-05c (owner's update to (428), and (431)): the delivery-report route logs its shape (names only), and marketing SMS
// stay off until SMS_MARKETING_ENABLED=on.

const root = join(__dirname, "..", "..");
const SECRET = "w".repeat(48);
const env = { INFORU_WEBHOOK_SECRET: SECRET };
const JOB = "11111111-1111-4111-8111-111111111111";
const PHONE = "0527777888";
const TEXT = "%D7%A1%D7%95%D7%93"; // "סוד"
const fakeDb = (): InforuWebhookDb => ({ deliveryStatus: vi.fn(async () => ({ delivered: 1, failed: 0, pending: 0 })), inboundReply: vi.fn() });
const url = (query = "") => `https://mexuzsystem.com/api/sms/inforu/status/${SECRET}${query}`;

/** The shape line as the logger writes it (every value judged by its field's kind). */
async function shapeLine(request: Request) {
  const log = vi.fn();
  const response = await inforuStatusRoute(request, SECRET, { db: fakeDb, log, env });
  const call = log.mock.calls.find(([event]) => event === "sms.inforu.status_shape");
  return { response, log, line: call ? logRecord("info", call[0], call[1]) : null };
}

describe("SMS-05c: the delivery report's shape in the log", () => {
  it("a form body: method, media type, size bucket and the field names, never a value", async () => {
    const body = `PhoneNumber=${PHONE}&Status=2&CustomerMessageId=${JOB}&OriginalMessage=${TEXT}&SenderNumber=MEXUZ&Status=2`;
    const { response, line } = await shapeLine(
      new Request(url(), { method: "POST", headers: { "Content-Type": "Application/X-WWW-Form-Urlencoded; charset=UTF-8" }, body }),
    );
    expect(response.status).toBe(200);
    expect(line).toMatchObject({
      event: "sms.inforu.status_shape",
      method: "POST",
      content_type: "application/x-www-form-urlencoded",
      has_body: true,
      body_size: "1-255",
      body_format: "form",
      has_query: false,
      body_fields: "PhoneNumber,Status,CustomerMessageId,OriginalMessage,SenderNumber",
      other_fields: 0,
    });
    const text = JSON.stringify(line);
    for (const value of [PHONE, JOB, "MEXUZ", "סוד", TEXT, SECRET]) expect(text).not.toContain(value);
  });

  it("JSON: the keys of the first item only", async () => {
    const body = JSON.stringify([{ PhoneNumber: PHONE, Status: 2, CustomerMessageId: JOB, OriginalMessage: "סוד" }, { Other: 1 }]);
    const { line } = await shapeLine(new Request(url(), { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    expect(line).toMatchObject({ body_format: "json", content_type: "application/json", body_fields: "PhoneNumber,Status,CustomerMessageId,OriginalMessage" });
    expect(JSON.stringify(line)).not.toMatch(/0527777888|סוד|Other/);
  });

  it("the query: its keys, and GET reads only the query", async () => {
    const { response, line } = await shapeLine(new Request(url(`?Status=-2&CustomerMessageId=${JOB}&PhoneNumber=${PHONE}`), { method: "GET" }));
    expect(response.status).toBe(200);
    expect(line).toMatchObject({ method: "GET", content_type: "none", has_body: false, body_size: "0", body_format: "empty", has_query: true, query_fields: "Status,CustomerMessageId,PhoneNumber" });
    expect(JSON.stringify(line)).not.toMatch(/0527777888|11111111/);
  });

  it("names that are not plain names (a number, a text, a symbol, too long) are counted, never written", async () => {
    const body = `${PHONE}=1&hello there=2&a%40b.com=3&${"x".repeat(41)}=4&Ok_1=5&just text without equals`;
    const { line } = await shapeLine(new Request(url("?0521234567=1&Good=2"), { method: "POST", headers: { "Content-Type": "text/plain" }, body }));
    expect(line).toMatchObject({ body_format: "form", body_fields: "Ok_1", query_fields: "Good", other_fields: 5 });
    expect(JSON.stringify(line)).not.toMatch(/0527777888|0521234567|hello|a@b|xxxxx|just/);
    expect(loggableFieldName("12345")).toBe(false);
    expect(loggableFieldName("Phone12345")).toBe(false);
    expect(loggableFieldName("Status")).toBe(true);
  });

  it("at most 30 names; a body over the limit is logged as such and refused", async () => {
    const keys = Array.from({ length: 35 }, (_, i) => `Field${i}=x`).join("&");
    const { line } = await shapeLine(new Request(url(), { method: "POST", body: keys }));
    expect((line?.body_fields as string).split(",")).toHaveLength(30);
    expect(line?.other_fields).toBe(5);
    const big = await shapeLine(new Request(url(), { method: "POST", body: "x".repeat(256 * 1024 + 1) }));
    expect(big.response.status).toBe(413);
    expect(big.line).toMatchObject({ body_size: "over_limit", body_format: "unread" });
  });

  it("a wrong secret logs nothing; the secret path is never in a line", async () => {
    const log = vi.fn();
    expect((await inforuStatusRoute(new Request(url(), { method: "GET" }), "wrong", { db: fakeDb, log, env })).status).toBe(404);
    expect(log).not.toHaveBeenCalled();
    const { log: ok } = await shapeLine(new Request(url(`?Status=2&CustomerMessageId=${JOB}`), { method: "POST" }));
    expect(JSON.stringify(ok.mock.calls)).not.toContain(SECRET);
  });

  it("the helpers: media type and size bucket", () => {
    expect(mediaTypeOf(null)).toBe("none");
    expect(mediaTypeOf("text/plain; charset=utf-8")).toBe("text/plain");
    expect(mediaTypeOf("text/<script>")).toBe("other");
    expect(mediaTypeOf("a/" + "b".repeat(70))).toBe("other");
    expect(bodySizeBucket(0)).toBe("0");
    expect(bodySizeBucket(256)).toBe("256-1k");
    expect(bodySizeBucket(70_000)).toBe("64k-256k");
  });

  it("the new log fields are in the closed list with their kinds; the logger drops an odd media type or name", () => {
    expect(LOG_FIELDS).toMatchObject({ content_type: "media_type", body_fields: "names", query_fields: "names", other_fields: "number", has_body: "boolean", has_query: "boolean" });
    expect(logRecord("info", "x", { content_type: "Text/HTML", body_fields: ["Status", PHONE, "a b"] })).not.toHaveProperty("content_type");
    expect(logRecord("info", "x", { body_fields: ["Status", PHONE, "a b", "Status"] })).toMatchObject({ body_fields: "Status" });
    expect(logRecord("info", "x", { body_fields: "Status" })).not.toHaveProperty("body_fields");
  });

  it("the route answers GET too", () => {
    const route = readFileSync(join(root, "src/app/api/sms/inforu/status/[secret]/route.ts"), "utf8");
    expect(route).toMatch(/export async function GET/);
    expect(route).toMatch(/export async function POST/);
  });
});

describe("SMS-05c: marketing SMS stay off until the owner turns them on (owner (431))", () => {
  beforeEach(() => clearFakeSentMessages());
  const job = (payload: Record<string, unknown>): ClaimedJob => ({
    id: JOB,
    lease: "22222222-1111-4111-8111-111111111111",
    kind: "message.send",
    organization_id: "33333333-1111-4111-8111-111111111111",
    payload: { channel: "sms", contact_id: "44444444-1111-4111-8111-111111111111", ...payload },
    attempt: 1,
  });

  it("the switch is on only for exactly \"on\"", () => {
    expect(marketingSmsEnabled({})).toBe(false);
    for (const value of ["", "true", "1", "ON", " on", "yes"]) expect(marketingSmsEnabled({ SMS_MARKETING_ENABLED: value })).toBe(false);
    expect(marketingSmsEnabled({ SMS_MARKETING_ENABLED: "on" })).toBe(true);
  });

  it("off (and by default): a marketing SMS ends refused before the send check, nothing counted, composed or sent", async () => {
    for (const smsMarketingOn of [undefined, () => false]) {
      const maySend = vi.fn(async () => ({ may_send: true }));
      const compose = vi.fn();
      const returnQuota = vi.fn();
      const handler = createSendHandler({ maySend, compose, returnQuota, providerFor: () => createFakeProvider({ channel: "sms" }), ...(smsMarketingOn ? { smsMarketingOn } : {}) });
      for (const payload of [{ message_type: "marketing" }, { message_type: "review_request" }, {}]) {
        expect(await handler(job(payload))).toEqual({
          status: "failed",
          error: `refused ${MARKETING_SMS_OFF_CODE}`,
          final: true,
          receipt: { provider: null, errorCode: MARKETING_SMS_OFF_CODE },
        });
      }
      expect(maySend).not.toHaveBeenCalled();
      expect(compose).not.toHaveBeenCalled();
      expect(returnQuota).not.toHaveBeenCalled();
      expect(fakeSentMessages()).toHaveLength(0);
    }
  });

  it("service messages always go; marketing goes once on; email is never gated", async () => {
    const handler = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: (channel) => createFakeProvider({ channel }) });
    for (const type of SERVICE_MESSAGE_TYPES.filter((t) => t !== "verification_code")) {
      expect(await handler(job({ message_type: type }))).toMatchObject({ status: "done" });
    }
    expect(await handler(job({ message_type: "verification_code", contact_id: undefined, sender_check_id: JOB }))).toMatchObject({ status: "done" });
    expect(await handler({ ...job({ message_type: "marketing" }), payload: { channel: "email", contact_id: JOB, message_type: "marketing" } })).toMatchObject({ status: "done" });
    const on = createSendHandler({ maySend: async () => ({ may_send: true }), providerFor: () => createFakeProvider({ channel: "sms" }), smsMarketingOn: () => true });
    expect(await on(job({ message_type: "marketing" }))).toMatchObject({ status: "done" });
  });

  it("the worker reads the switch from SMS_MARKETING_ENABLED; .env.example documents it empty; the timeline reads it in Hebrew", () => {
    const server = readFileSync(join(root, "src/features/jobs/run-server.ts"), "utf8");
    expect(server).toContain("smsMarketingOn: () => marketingSmsEnabled(process.env)");
    expect(readFileSync(join(root, ".env.example"), "utf8")).toMatch(/^SMS_MARKETING_ENABLED=$/m);
    expect(REFUSED[MARKETING_SMS_OFF_CODE]).toBe("לא נשלחה: שליחת SMS שיווקי עדיין לא פעילה.");
  });
});

describe("SMS-05c review: names and media types stay names", () => {
  it("refuses long hex runs, long names and odd media types", () => {
    expect(loggableFieldName("CustomerMessageId")).toBe(true);
    expect(loggableFieldName("a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6")).toBe(false);
    expect(loggableFieldName("abcdefABCDEF0123")).toBe(false);
    expect(loggableFieldName("x".repeat(25))).toBe(false);
    expect(mediaTypeOf("application/x-www-form-urlencoded; charset=utf-8")).toBe("application/x-www-form-urlencoded");
    expect(mediaTypeOf("application/json")).toBe("application/json");
    expect(mediaTypeOf("text/0527777888")).toBe("other");
    expect(mediaTypeOf("8a1b2c3d-1111-2222-3333-444455556666")).toBe("other");
  });
});

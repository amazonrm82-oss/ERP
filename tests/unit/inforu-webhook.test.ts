import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { deliveryItems, inboundItems, inforuInboundRoute, inforuStatusRoute, type InforuWebhookDb } from "@/features/inforu-callbacks/webhook";
import { redactPublicPath } from "@/lib/request-error-log";

// SMS-05 (owner (318) א), wave 3 use (2): InforU's callbacks are refused before the body is read without the path secret.

const SECRET = "w".repeat(48);
const env = { INFORU_WEBHOOK_SECRET: SECRET };
const JOB = "11111111-1111-4111-8111-111111111111";

const post = (body: unknown) => new Request("https://mexuzsystem.com/api/sms/inforu/status/x", { method: "POST", body: JSON.stringify(body) });
const fakeDb = (answer: unknown = { delivered: 1, failed: 0 }) => {
  const db: InforuWebhookDb = { deliveryStatus: vi.fn(async () => answer), inboundReply: vi.fn(async () => ({ status: "done" })) };
  return db;
};

describe("SMS-05: InforU's callbacks", () => {
  it("a wrong or missing secret is refused and the body is never read", async () => {
    const db = fakeDb();
    const log = vi.fn();
    const request = post([{ CustomerMessageId: JOB, Status: 2 }]);
    expect((await inforuStatusRoute(request, "wrong", { db: () => db, log, env })).status).toBe(404);
    expect(request.bodyUsed).toBe(false);
    expect((await inforuInboundRoute(post({}), SECRET, { db: () => db, log, env: {} })).status).toBe(404);
    expect((await inforuStatusRoute(post([]), SECRET, { db: () => null, log, env })).status).toBe(503);
    expect(db.deliveryStatus).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("RVW-101: the service-key client is made only after the secret passed", async () => {
    const make = vi.fn(() => fakeDb());
    expect((await inforuStatusRoute(post([]), "wrong", { db: make, log: vi.fn(), env })).status).toBe(404);
    expect((await inforuInboundRoute(post({}), "wrong", { db: make, log: vi.fn(), env })).status).toBe(404);
    expect((await inforuInboundRoute(post({}), SECRET, { db: make, log: vi.fn(), env: {} })).status).toBe(404);
    expect(make).not.toHaveBeenCalled();
    expect((await inforuStatusRoute(post([]), SECRET, { db: make, log: vi.fn(), env })).status).toBe(200);
    expect(make).toHaveBeenCalledTimes(1);
    // the server file hands the factory itself to the routes, never a client built up front
    const server = readFileSync(path.join(process.cwd(), "src/features/inforu-callbacks/webhook-server.ts"), "utf8");
    expect(server).toMatch(/\{ db: database, log \}/);
    expect(server).not.toMatch(/db: database\(\)/);
  });

  it("a delivery report hands the database our job ids and states only, and logs a count", async () => {
    const db = fakeDb();
    const log = vi.fn();
    const response = await inforuStatusRoute(
      post([
        { InforuId: "x", PhoneNumber: "0521234567", Status: 2, CustomerMessageId: JOB, OriginalMessage: "סוד" },
        { Status: -2, CustomerMessageId: JOB.replace("1111-4", "2222-4") },
        { Status: 6, CustomerMessageId: JOB },
      ]),
      SECRET,
      { db: () => db, log, env },
    );
    expect(response.status).toBe(200);
    expect(db.deliveryStatus).toHaveBeenCalledWith([
      { id: JOB, status: "delivered" },
      { id: "11111111-2222-4111-8111-111111111111", status: "failed", code: "inforu_undelivered" },
    ]);
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/0521234567|סוד/);
    // review (5), (6): a limit or a report before the message row answers 503, so InforU posts it again
    expect((await inforuStatusRoute(post([{ CustomerMessageId: JOB, Status: 2 }]), SECRET, { db: () => fakeDb({ rate_limited: true }), log, env })).status).toBe(503);
    expect((await inforuStatusRoute(post([{ CustomerMessageId: JOB, Status: 2 }]), SECRET, { db: () => fakeDb({ delivered: 0, failed: 0, pending: 1 }), log, env })).status).toBe(503);
    expect((await inforuStatusRoute(post([{ CustomerMessageId: JOB, Status: 2 }]), SECRET, { db: () => fakeDb({ delivered: 0, failed: 0, pending: 0 }), log, env })).status).toBe(200);
  });

  it("refuses a body over 256 KB and a malformed one", async () => {
    const db = fakeDb();
    const big = new Request("https://x.test/", { method: "POST", body: "x".repeat(256 * 1024 + 1) });
    expect((await inforuStatusRoute(big, SECRET, { db: () => db, log: vi.fn(), env })).status).toBe(413);
    const bad = new Request("https://x.test/", { method: "POST", body: "{" });
    expect((await inforuInboundRoute(bad, SECRET, { db: () => db, log: vi.fn(), env })).status).toBe(400);
  });

  it("replies go to the database one by one, SMS only", async () => {
    const db = fakeDb();
    const response = await inforuInboundRoute(
      post({ CustomerId: 1, Data: [{ Channel: "SMS_MO", Value: "0521234567", Message: "הסר" }, { Channel: "WA", Value: "1", Message: "x" }] }),
      SECRET,
      { db: () => db, log: vi.fn(), env },
    );
    expect(response.status).toBe(200);
    expect(db.inboundReply).toHaveBeenCalledTimes(1);
    expect(db.inboundReply).toHaveBeenCalledWith({ phone: "0521234567", body: "הסר" });
    const limitedDb: InforuWebhookDb = { deliveryStatus: vi.fn(), inboundReply: vi.fn(async () => ({ rate_limited: true, scope: "number" })) };
    const log = vi.fn();
    expect((await inforuInboundRoute(post({ Data: [{ Value: "0521234567", Message: "הסר" }] }), SECRET, { db: () => limitedDb, log, env })).status).toBe(503);
    expect(log).toHaveBeenCalledWith("sms.inforu.inbound_limited", { count: 1, reason: "rate_limited" });
    const businessLimited: InforuWebhookDb = { deliveryStatus: vi.fn(), inboundReply: vi.fn(async () => ({ status: "done", limited: 1 })) };
    expect((await inforuInboundRoute(post({ Data: [{ Value: "0521234567", Message: "הסר" }] }), SECRET, { db: () => businessLimited, log, env })).status).toBe(503);
  });

  it("parsers keep only what is needed", () => {
    expect(deliveryItems({ CustomerMessageId: JOB.toUpperCase(), Status: "2" })).toEqual([{ id: JOB, status: "delivered" }]);
    expect(deliveryItems([{ CustomerMessageId: "not-ours", Status: 2 }])).toEqual([]);
    expect(inboundItems({ Data: [{ Value: "05", Message: "x".repeat(1001) }] })).toEqual([]);
    expect(inboundItems([])).toEqual([]);
  });

  it("SMS-05b: reads InforU's default push (form parameters in the body, or in the query) as well as JSON", async () => {
    const db = fakeDb();
    const log = vi.fn();
    // SMS API 6.1, page 13: the parameters of the default push
    const form =
      `PhoneNumber=0527777888&Network=052&Status=2&StatusDescription=Delivered&ProjectId=10838&CustomerMessageId=${JOB}` +
      "&CustomerParam=&id=&SenderNumber=MEXUZ&BillingCodeId=1&Price=0.00&SegmentsNumber=1&ActionType=Content" +
      "&OriginalMessage=%D7%A1%D7%95%D7%93&NotificationDate=18/11/2026 17:07:00&RetriesNumber=0";
    const byForm = new Request("https://mexuzsystem.com/api/sms/inforu/status/x", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect((await inforuStatusRoute(byForm, SECRET, { db: () => db, log, env })).status).toBe(200);
    expect(db.deliveryStatus).toHaveBeenLastCalledWith([{ id: JOB, status: "delivered" }]);
    const byQuery = new Request(`https://mexuzsystem.com/api/sms/inforu/status/x?Status=-2&CustomerMessageId=${JOB.toUpperCase()}&PhoneNumber=0527777888`, { method: "POST" });
    expect((await inforuStatusRoute(byQuery, SECRET, { db: () => db, log, env })).status).toBe(200);
    expect(db.deliveryStatus).toHaveBeenLastCalledWith([{ id: JOB, status: "failed", code: "inforu_undelivered" }]);
    // never the number, the text or the sender in a log line
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/0527777888|סוד|MEXUZ/);
    // a body that is neither is refused and counted in the logs, without its content
    const junk = new Request("https://x.test/", { method: "POST", body: "hello 0527777888" });
    expect((await inforuStatusRoute(junk, SECRET, { db: () => db, log, env })).status).toBe(400);
    expect(log).toHaveBeenLastCalledWith("sms.inforu.status_unreadable", { reason: "format" });
    const broken = new Request("https://x.test/", { method: "POST", body: "[{" });
    expect((await inforuStatusRoute(broken, SECRET, { db: () => db, log, env })).status).toBe(400);
    // a report that names none of our messages (a click) is answered 200 and counted
    expect((await inforuStatusRoute(post([{ CustomerMessageId: JOB, Status: 6 }]), SECRET, { db: () => db, log, env })).status).toBe(200);
    expect(log).toHaveBeenLastCalledWith("sms.inforu.status_ignored", { count: 1 });
  });

  it("the secret in the path never reaches a log line", () => {
    expect(redactPublicPath(`/api/sms/inforu/status/${SECRET}`)).toBe("/api/sms/inforu/status/[token]");
    expect(redactPublicPath(`/api/sms/inforu/inbound/${SECRET}`)).toBe("/api/sms/inforu/inbound/[token]");
  });
});

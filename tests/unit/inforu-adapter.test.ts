import { describe, expect, it, vi } from "vitest";

import { createInforuProvider, INFORU_SEND_URL, inforuPhone, inforuSecretMatches, inforuWebhookSecret } from "@/features/messaging/providers/inforu";
import type { OutgoingMessage } from "@/features/messaging/providers/types";
import { createSendHandler, parseComposed } from "@/features/messaging/send-handler";
import type { ClaimedJob } from "@/features/jobs/registry";

// SMS-05 (owner (318) א): the InforU adapter, with a mocked fetch. The text and the number come from the composer only.

const SECRET = "s".repeat(40);
const ENV = {
  INFORU_USERNAME: "mexuz",
  INFORU_API_TOKEN: "token-123",
  INFORU_SENDER: "Mexuz",
  INFORU_WEBHOOK_SECRET: SECRET,
  NEXT_PUBLIC_SITE_URL: "https://mexuzsystem.com/",
};

const message = (content?: OutgoingMessage["content"]): OutgoingMessage => ({
  jobId: "11111111-1111-4111-8111-111111111111",
  organizationId: "o",
  channel: "sms",
  messageType: "requested_document",
  purpose: "service",
  recordType: "lead",
  recordId: "r",
  ...(content ? { content } : {}),
});
const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("SMS-05: the InforU adapter", () => {
  it("posts one JSON message with basic auth, the local number, the sender and our delivery URL", async () => {
    const fetch = vi.fn(async () => answer({ StatusId: 1, StatusDescription: "Success", RequestId: "x", Data: { Recipients: 1 } }));
    const provider = createInforuProvider(ENV, { fetch })!;
    expect(provider.composes).toBe(true);
    const result = await provider.send(message({ to: "+972521234567", sender: "MyShop", text: "שלום דנה" }));
    expect(result).toEqual({ ok: true, providerId: "11111111-1111-4111-8111-111111111111" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(INFORU_SEND_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("mexuz:token-123").toString("base64")}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      Data: {
        Message: "שלום דנה",
        Recipients: [{ Phone: "0521234567", CustomerMessageID: "11111111-1111-4111-8111-111111111111" }],
        Settings: {
          Sender: "MyShop",
          CustomerMessageID: "11111111-1111-4111-8111-111111111111",
          AllowDuplicates: false,
          // owner (325) ב: InforU's own unsubscribe list is off
          IgnoreUnsubscribeCheck: true,
          DeliveryNotificationUrl: `https://mexuzsystem.com/api/sms/inforu/status/${SECRET}`,
        },
      },
    });
  });

  it("falls back to the platform's sender, and sends no delivery URL without the secret", async () => {
    const fetch = vi.fn(async () => answer({ StatusId: 1 }));
    const provider = createInforuProvider({ ...ENV, INFORU_WEBHOOK_SECRET: "short" }, { fetch })!;
    await provider.send(message({ to: "+972521234567", sender: null, text: "x" }));
    const settings = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).Data.Settings;
    expect(settings.Sender).toBe("Mexuz");
    expect(settings.DeliveryNotificationUrl).toBeUndefined();
  });

  it("maps InforU's answers to final or retryable codes, and never sends without content or to a foreign number", async () => {
    const make = (impl: () => Promise<Response>) => createInforuProvider(ENV, { fetch: vi.fn(impl) })!;
    const content = { to: "+972521234567", sender: null, text: "x" };
    // delta review (3): an explicit refusal is final and notSent (the count goes back); the throttle is retried, still counted
    expect(await make(async () => answer({ StatusId: -94 })).send(message(content))).toMatchObject({ ok: false, code: "status_m94", final: true, notSent: true });
    expect(await make(async () => answer({ StatusId: -2 }, 401)).send(message(content))).toMatchObject({ code: "status_m2", final: true, notSent: true });
    expect(await make(async () => answer({}, 403)).send(message(content))).toMatchObject({ code: "http_403", final: true, notSent: true });
    expect(await make(async () => answer({ StatusId: -429 })).send(message(content))).not.toHaveProperty("notSent");
    expect(await make(async () => answer({}, 429)).send(message(content))).not.toHaveProperty("notSent");
    expect(await make(async () => answer({ StatusId: -429 })).send(message(content))).toMatchObject({ ok: false, code: "status_m429", final: false });
    expect(await make(async () => answer({ StatusId: -13 })).send(message(content))).toMatchObject({ ok: false, code: "status_m13", final: true });
    // review (2): once the request may have reached InforU the job ends "unknown", never a second send
    expect(await make(async () => answer({}, 500)).send(message(content))).toMatchObject({ ok: false, code: "unknown_http_500", final: true });
    expect(await make(async () => new Response("<html>", { status: 200 })).send(message(content))).toMatchObject({ code: "unknown_answer", final: true });
    expect(await make(async () => answer({}, 429)).send(message(content))).toMatchObject({ code: "http_429", final: false });
    expect(
      await make(async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      }).send(message(content)),
    ).toMatchObject({ ok: false, code: "unknown_timeout", final: true });
    expect(
      await make(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      }).send(message(content)),
    ).toMatchObject({ code: "unknown_network", final: true });
    // may have been sent: no notSent, the count stays
    expect(await make(async () => answer({}, 500)).send(message(content))).not.toHaveProperty("notSent");
    // no connection was made: nothing was sent, so it is tried again
    expect(
      await make(async () => {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }).send(message(content)),
    ).toMatchObject({ code: "network", final: false, notSent: true });
    const never = vi.fn(async () => answer({ StatusId: 1 }));
    const provider = createInforuProvider(ENV, { fetch: never })!;
    // owner (326) ב: never reached InforU = notSent (the count goes back)
    expect(await provider.send(message())).toMatchObject({ ok: false, code: "no_content", notSent: true });
    expect(await provider.send(message({ ...content, to: "+12025550100" }))).toMatchObject({ ok: false, code: "foreign_number", final: true, notSent: true });
    expect(never).not.toHaveBeenCalled();
    await expect(createInforuProvider({ ...ENV, INFORU_SENDER: "" }, { fetch: never })!.send(message(content))).resolves.toMatchObject({ code: "no_sender" });
  });

  it("an error never carries the token, the number or the text", async () => {
    const provider = createInforuProvider(ENV, { fetch: vi.fn(async () => answer({ StatusId: -2, StatusDescription: "Bad user name token-123 0521234567" })) })!;
    const result = await provider.send(message({ to: "+972521234567", sender: null, text: "סוד" }));
    expect(JSON.stringify(result)).not.toMatch(/token-123|0521234567|סוד/);
  });

  it("local numbers and the webhook secret", () => {
    expect(inforuPhone("+972521234567")).toBe("0521234567");
    expect(inforuPhone("+97231234567")).toBe("031234567");
    expect(inforuPhone("+447700900000")).toBeNull();
    expect(inforuWebhookSecret({ INFORU_WEBHOOK_SECRET: "x".repeat(31) })).toBeNull();
    expect(inforuSecretMatches(SECRET, ENV)).toBe(true);
    expect(inforuSecretMatches(`${SECRET}x`, ENV)).toBe(false);
    expect(inforuSecretMatches("", ENV)).toBe(false);
    expect(inforuSecretMatches(SECRET, {})).toBe(false);
  });
});

describe("SMS-05: the send handler asks the composer for a composing provider", () => {
  const job: ClaimedJob = {
    id: "11111111-1111-4111-8111-111111111111",
    lease: "22222222-2222-4222-8222-222222222222",
    kind: "message.send",
    organization_id: "33333333-3333-4333-8333-333333333333",
    payload: { channel: "sms", message_type: "requested_document", lead_id: "44444444-4444-4444-8444-444444444444", template_id: "55555555-5555-4555-8555-555555555555" },
    attempt: 1,
  };

  it("hands the composed content to the adapter after the send check", async () => {
    const send = vi.fn(async () => ({ ok: true as const, providerId: job.id }));
    const order: string[] = [];
    const handler = createSendHandler({
      providerFor: () => ({ name: "inforu", channel: "sms", composes: true, send }),
      maySend: async () => (order.push("may"), { may_send: true }),
      compose: async () => (order.push("compose"), { to: "+972521234567", sender: null, text: "שלום" }),
    });
    expect(await handler(job)).toEqual({ status: "done", receipt: { provider: "inforu", providerMessageId: job.id } });
    expect(order).toEqual(["may", "compose"]);
    expect((send.mock.calls[0] as unknown as [OutgoingMessage])[0].content).toEqual({ to: "+972521234567", sender: null, text: "שלום" });
  });

  it("a refusal ends the job with the code and no provider; a stale lease or a malformed answer is a retry", async () => {
    const send = vi.fn();
    const base = { providerFor: () => ({ name: "inforu", channel: "sms" as const, composes: true, send }), maySend: async () => ({ may_send: true }) };
    expect(await createSendHandler({ ...base, compose: async () => ({ refused: "unfilled_field" }) })(job)).toEqual({
      status: "failed",
      error: "refused unfilled_field",
      final: true,
      receipt: { provider: null, errorCode: "unfilled_field" },
    });
    expect(await createSendHandler({ ...base, compose: async () => ({ refused: "stale" }) })(job)).toEqual({ status: "failed", error: "stale lease" });
    // review (3): a paused business or a missing site address waits (not final)
    expect(await createSendHandler({ ...base, compose: async () => ({ refused: "paused" }) })(job)).toEqual({ status: "failed", error: "waiting paused" });
    expect(await createSendHandler({ ...base, compose: async () => ({ refused: "site_url" }) })(job)).toEqual({ status: "failed", error: "waiting site_url" });
    expect(await createSendHandler({ ...base, compose: async () => ({ to: "052", text: "x" }) })(job)).toEqual({ status: "failed", error: "composer answered nothing" });
    // the send check said no: the composer is never asked
    const compose = vi.fn();
    expect(await createSendHandler({ ...base, maySend: async () => ({ may_send: false, reason: "consent" }), compose })(job)).toEqual({ status: "ended", reason: "consent" });
    expect(compose).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("gives the SMS count back only for a message that never reached the provider (owner (326) ב)", async () => {
    const returnQuota = vi.fn(async () => ({ returned: true }));
    const base = { maySend: async () => ({ may_send: true }), compose: async () => ({ to: "+972521234567", sender: null, text: "x" }), returnQuota };
    const never = { ok: false as const, error: "e", code: "network", final: false, notSent: true };
    await createSendHandler({ ...base, providerFor: () => ({ name: "inforu", channel: "sms", composes: true, send: async () => never }) })(job);
    expect(returnQuota).toHaveBeenCalledTimes(1);
    const maybe = { ok: false as const, error: "e", code: "unknown_timeout", final: true };
    await createSendHandler({ ...base, providerFor: () => ({ name: "inforu", channel: "sms", composes: true, send: async () => maybe }) })(job);
    expect(returnQuota).toHaveBeenCalledTimes(1);
  });

  it("parses the composer's answer strictly", () => {
    expect(parseComposed({ to: "+972521234567", sender: "X", text: "t" })).toEqual({ ok: true, content: { to: "+972521234567", sender: "X", text: "t" } });
    expect(parseComposed({ refused: "bad code!" })).toBeNull();
    expect(parseComposed({ to: "+972521234567", sender: 5, text: "t" })).toBeNull();
    expect(parseComposed(null)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { createFakePaymentProvider, fakeWebhookRequest } from "@/features/payment-links/providers/fake";
import { paymentWebhookRoute, type PaymentWebhookDb } from "@/features/payment-links/webhook";

const event = { eventId: "ev_1", providerLinkId: "fake_k1", status: "paid" as const, paidAgorot: 5000, currency: "ILS", providerPaymentId: "fake_payment_1", installments: 2 };

function setup(answer: unknown = { status: "recorded" }) {
  const calls: { provider: string; event: Record<string, unknown> }[] = [];
  const logs: { event: string; fields: Record<string, unknown> }[] = [];
  let dbMade = 0;
  const db: PaymentWebhookDb = {
    record: async (provider, e) => {
      calls.push({ provider, event: e });
      return answer;
    },
  };
  const deps = {
    provider: () => createFakePaymentProvider(),
    db: () => {
      dbMade += 1;
      return db;
    },
    log: (e: string, fields: Record<string, unknown>) => logs.push({ event: e, fields }),
  };
  return { deps, calls, logs, made: () => dbMade };
}

const post = (body: string, headers: Headers) => new Request("https://x.example/api/payments/fake/webhook", { method: "POST", body, headers });

describe("payment provider webhook (LNK-04)", () => {
  it("a validly signed event reaches the database as ids and codes only", async () => {
    const s = setup();
    const signed = fakeWebhookRequest(event);
    const res = await paymentWebhookRoute(post(signed.body, signed.headers), "fake", s.deps);
    expect(res.status).toBe(200);
    expect(s.calls).toEqual([
      { provider: "fake", event: { event_id: "ev_1", provider_link_id: "fake_k1", status: "paid", paid_agorot: 5000, currency: "ILS", provider_payment_id: "fake_payment_1", installments: 2 } },
    ]);
  });

  it("a bad signature is refused before the database, with no detail and no body in the log", async () => {
    const s = setup();
    const signed = fakeWebhookRequest(event, "another-secret");
    const res = await paymentWebhookRoute(post(signed.body, signed.headers), "fake", s.deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(s.made()).toBe(0);
    expect(JSON.stringify(s.logs)).not.toContain("fake_k1");
    // a changed body under the old signature, and no signature at all
    const tampered = await paymentWebhookRoute(post(signed.body.replace("5000", "1"), fakeWebhookRequest(event).headers), "fake", s.deps);
    expect(tampered.status).toBe(401);
    expect((await paymentWebhookRoute(post(signed.body, new Headers()), "fake", s.deps)).status).toBe(401);
    expect(s.made()).toBe(0);
  });

  it("another provider's path is not found; a large body is refused; busy and invalid map to 503 and 400", async () => {
    const s = setup();
    const signed = fakeWebhookRequest(event);
    expect((await paymentWebhookRoute(post(signed.body, signed.headers), "cardcom", s.deps)).status).toBe(404);
    const big = "x".repeat(70 * 1024);
    expect((await paymentWebhookRoute(post(big, new Headers()), "fake", s.deps)).status).toBe(413);
    expect(s.made()).toBe(0);
    const busy = await paymentWebhookRoute(post(signed.body, signed.headers), "fake", setup({ status: "busy" }).deps);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("60");
    expect((await paymentWebhookRoute(post(signed.body, signed.headers), "fake", setup({ status: "invalid" }).deps)).status).toBe(400);
    expect((await paymentWebhookRoute(post(signed.body, signed.headers), "fake", setup({ status: "duplicate" }).deps)).status).toBe(200);
  });

  it("review 7: a fake without its secret accepts no webhook outside the test runner", async () => {
    const env = process.env as Record<string, string | undefined>;
    const before = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const s = setup();
      const signed = fakeWebhookRequest(event);
      const res = await paymentWebhookRoute(post(signed.body, signed.headers), "fake", { ...s.deps, provider: () => createFakePaymentProvider() });
      expect(res.status).toBe(401);
      expect(s.made()).toBe(0);
    } finally {
      env.NODE_ENV = before;
    }
  });

  it("without a provider here the route does not exist", async () => {
    const s = setup();
    const signed = fakeWebhookRequest(event);
    expect((await paymentWebhookRoute(post(signed.body, signed.headers), "fake", { ...s.deps, provider: () => null })).status).toBe(404);
  });
});

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createFakePaymentProvider, FAKE_SIGNATURE_HEADER, fakePaymentLinkId, signFakeWebhook } from "@/features/payment-links/providers/fake";
import { paymentProvider, paymentProviderCode } from "@/features/payment-links/providers/select";
import { isPaymentProviderCode } from "@/features/payment-links/providers/types";

const root = join(__dirname, "..", "..");

const LINK = "11111111-1111-4111-8111-111111111111";

describe("LNK-01: choosing the payment provider", () => {
  it("has none without PAYMENT_LINKS_PROVIDER, or with an unknown code (the feature is hidden)", () => {
    expect(paymentProvider({})).toBeNull();
    expect(paymentProvider({ PAYMENT_LINKS_PROVIDER: "tranzila" })).toBeNull();
    expect(paymentProvider({ PAYMENT_LINKS_PROVIDER: "toString" })).toBeNull();
  });

  it("gives the fake only off Vercel or on a Vercel development environment (owner (270) (1) א)", () => {
    expect(paymentProviderCode({ PAYMENT_LINKS_PROVIDER: "fake" })).toBe("fake");
    expect(paymentProviderCode({ PAYMENT_LINKS_PROVIDER: " FAKE ", VERCEL_ENV: "development" })).toBe("fake");
    expect(paymentProviderCode({ PAYMENT_LINKS_PROVIDER: "fake", VERCEL_ENV: "production" })).toBeNull();
    expect(paymentProviderCode({ PAYMENT_LINKS_PROVIDER: "fake", VERCEL_ENV: "preview" })).toBeNull();
  });


  it("knows only the fake, and names a fake link fake_<link id>", () => {
    expect(isPaymentProviderCode("fake")).toBe(true);
    expect(isPaymentProviderCode("cardcom")).toBe(false);
    expect(fakePaymentLinkId(LINK)).toBe(`fake_${LINK}`);
  });
});

describe("LNK-01: the fake adapter", () => {
  it("makes no page, keeps the link pending until settled, and refunds at most what was paid", async () => {
    const fake = createFakePaymentProvider();
    const page = await fake.createPaymentPage({
      linkId: LINK,
      organizationId: LINK,
      amountAgorot: 50_000,
      currency: "ILS",
      maxInstallments: 3,
      expiresAt: new Date().toISOString(),
      title: "תשלום",
    });
    expect(page).toEqual({ providerLinkId: fakePaymentLinkId(LINK), hostedUrl: null });
    expect((await fake.getStatus(page.providerLinkId)).status).toBe("pending");
    fake.settle(page.providerLinkId, "paid", 3);
    const status = await fake.getStatus(page.providerLinkId);
    expect(status).toMatchObject({ status: "paid", paidAgorot: 50_000, installments: 3 });
    expect(await fake.refund({ providerPaymentId: status.providerPaymentId!, amountAgorot: 60_000 })).toEqual({ ok: false, code: "not_refundable" });
    expect((await fake.refund({ providerPaymentId: status.providerPaymentId!, amountAgorot: 10_000 })).ok).toBe(true);
    // a settled link does not move again
    fake.settle(page.providerLinkId, "failed");
    expect((await fake.getStatus(page.providerLinkId)).status).toBe("paid");
  });

  it("charges only a token it made", async () => {
    const fake = createFakePaymentProvider();
    const token = await fake.createTokenPage({ organizationId: LINK, contactId: LINK, title: "שמירת כרטיס" });
    expect(token.hostedUrl).toBeNull();
    expect((await fake.chargeToken({ providerTokenId: token.providerLinkId, amountAgorot: 100, installments: 1, reference: "x" })).ok).toBe(true);
    expect(await fake.chargeToken({ providerTokenId: "fake_token_x", amountAgorot: 100, installments: 1, reference: "x" })).toEqual({ ok: false, code: "token_unknown" });
  });

  it("accepts a webhook only with a valid signature over the exact body", async () => {
    const fake = createFakePaymentProvider({ webhookSecret: "s3cret" });
    const body = JSON.stringify({ event_id: "ev_1", link_id: fakePaymentLinkId(LINK), status: "paid", paid_agorot: 100, currency: "ILS", payment_id: "p_1", installments: 2 });
    const signed = new Headers({ [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body, "s3cret") });
    expect(await fake.verifyWebhook({ headers: signed, body })).toEqual({
      ok: true,
      // LNK-04: the event's own id, so the database takes it once
      event: { eventId: "ev_1", providerLinkId: fakePaymentLinkId(LINK), status: "paid", paidAgorot: 100, currency: "ILS", providerPaymentId: "p_1", installments: 2 },
    });
    expect(await fake.verifyWebhook({ headers: signed, body: body.replace("100", "101") })).toEqual({ ok: false });
    expect(await fake.verifyWebhook({ headers: new Headers({ [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body, "other") }), body })).toEqual({ ok: false });
    expect(await fake.verifyWebhook({ headers: new Headers(), body })).toEqual({ ok: false });
    expect(await fake.verifyWebhook({ headers: new Headers({ [FAKE_SIGNATURE_HEADER]: "zz" }), body })).toEqual({ ok: false });
    const junk = "not json";
    expect(await fake.verifyWebhook({ headers: new Headers({ [FAKE_SIGNATURE_HEADER]: signFakeWebhook(junk, "s3cret") }), body: junk })).toEqual({ ok: false });
  });
});

describe("LNK-03: card details never pass through our code", () => {
  // every file of the feature: no field for a card number, a security code or a typed expiry
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  it("has no card-number or security-code field in src/features/payment-links", () => {
    const banned = /\b(card_?number|cardNumber|pan|cvv|cvc|cvv2|security_?code|securityCode)\b/i;
    for (const file of files(join(root, "src", "features", "payment-links"))) {
      const text = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      expect(banned.test(text), file).toBe(false);
    }
  });

});


import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CardToken,
  PaymentPage,
  PaymentProvider,
  PaymentStatusAnswer,
  PaymentWebhookEvent,
  ProviderLinkStatus,
  WebhookVerdict,
} from "./types";

/**
 * LNK-01: the fake adapter. It charges nothing, opens no page and calls no network. It keeps what it was asked in memory
 * of this server process, so tests can drive a link through paid or failed. Chosen only by PAYMENT_LINKS_PROVIDER=fake and
 * never on a Vercel production or preview deployment (select.ts).
 *
 * The provider id of a fake link is fixed by the link itself, `fake_<link id>`: the database writes the same id when the
 * link is made (app.payment_links_check), so no person's request ever writes a provider id.
 */
export function fakePaymentLinkId(linkId: string): string {
  return `fake_${linkId}`;
}

/** The header the fake's webhook is signed in: HMAC-SHA256 of the exact body, hex. */
export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

type Link = { status: ProviderLinkStatus; amountAgorot: number; paidAgorot: number | null; paymentId: string | null; installments: number | null };

const STATUSES: readonly ProviderLinkStatus[] = ["pending", "paid", "failed", "expired", "cancelled"];

export function signFakeWebhook(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function signatureMatches(given: string | null, body: string, secret: string): boolean {
  if (!given || !/^[0-9a-f]{64}$/.test(given)) return false;
  const wanted = Buffer.from(signFakeWebhook(body, secret), "hex");
  return timingSafeEqual(Buffer.from(given, "hex"), wanted);
}

function readEvent(body: string): PaymentWebhookEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const id = v.link_id;
  const status = v.status;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return null;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return null;
  const whole = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  return {
    providerLinkId: id,
    status: status as ProviderLinkStatus,
    paidAgorot: whole(v.paid_agorot),
    providerPaymentId: typeof v.payment_id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v.payment_id) ? v.payment_id : null,
    installments: whole(v.installments),
  };
}

export type FakePaymentProvider = PaymentProvider & {
  /** Tests: the payer paid (or failed) at the fake's page. */
  settle(providerLinkId: string, status: Exclude<ProviderLinkStatus, "pending">, installments?: number): void;
};

export function createFakePaymentProvider(options: { webhookSecret?: string } = {}): FakePaymentProvider {
  const secret = options.webhookSecret ?? "fake-payments-secret";
  const links = new Map<string, Link>();
  const tokens = new Map<string, CardToken>();
  let counter = 0;

  return {
    code: "fake",
    async createPaymentPage(request): Promise<PaymentPage> {
      const providerLinkId = fakePaymentLinkId(request.linkId);
      if (!links.has(providerLinkId)) {
        links.set(providerLinkId, { status: "pending", amountAgorot: request.amountAgorot, paidAgorot: null, paymentId: null, installments: null });
      }
      // no page of ours and no page anywhere: the fake has no address to send a payer to
      return { providerLinkId, hostedUrl: null };
    },
    async getStatus(providerLinkId): Promise<PaymentStatusAnswer> {
      const link = links.get(providerLinkId);
      if (!link) return { status: "expired", paidAgorot: null, providerPaymentId: null, installments: null };
      return { status: link.status, paidAgorot: link.paidAgorot, providerPaymentId: link.paymentId, installments: link.installments };
    },
    async refund(request) {
      if (!Number.isSafeInteger(request.amountAgorot) || request.amountAgorot < 1) return { ok: false, code: "amount" };
      const link = [...links.values()].find((l) => l.paymentId === request.providerPaymentId);
      if (!link || link.paidAgorot === null || request.amountAgorot > link.paidAgorot) return { ok: false, code: "not_refundable" };
      counter += 1;
      return { ok: true, providerRefundId: `fake_refund_${counter}` };
    },
    async createTokenPage(request): Promise<PaymentPage> {
      counter += 1;
      const id = `fake_token_${counter}`;
      tokens.set(id, { providerTokenId: id, last4: "0000", expiryMonth: 12, expiryYear: 2030 });
      void request;
      return { providerLinkId: id, hostedUrl: null };
    },
    async chargeToken(request) {
      if (!tokens.has(request.providerTokenId)) return { ok: false, code: "token_unknown" };
      if (!Number.isSafeInteger(request.amountAgorot) || request.amountAgorot < 1) return { ok: false, code: "amount" };
      counter += 1;
      return { ok: true, providerPaymentId: `fake_payment_${counter}` };
    },
    async verifyWebhook(input): Promise<WebhookVerdict> {
      if (!signatureMatches(input.headers.get(FAKE_SIGNATURE_HEADER), input.body, secret)) return { ok: false };
      const event = readEvent(input.body);
      return event ? { ok: true, event } : { ok: false };
    },
    settle(providerLinkId, status, installments = 1) {
      const link = links.get(providerLinkId);
      if (!link || link.status !== "pending") return;
      link.status = status;
      if (status === "paid") {
        counter += 1;
        link.paidAgorot = link.amountAgorot;
        link.paymentId = `fake_payment_${counter}`;
        link.installments = installments;
      }
    },
  };
}

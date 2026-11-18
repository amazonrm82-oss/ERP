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
  const eventId = v.event_id;
  if (typeof eventId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(eventId)) return null;
  const id = v.link_id;
  const status = v.status;
  if (typeof id !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)) return null;
  if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return null;
  const whole = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  return {
    eventId,
    providerLinkId: id,
    status: status as ProviderLinkStatus,
    paidAgorot: whole(v.paid_agorot),
    currency: typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency) ? v.currency : null,
    providerPaymentId: typeof v.payment_id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v.payment_id) ? v.payment_id : null,
    installments: whole(v.installments),
  };
}

/**
 * The secret the fake's tests sign with. Review 7: it is no public default: outside the test runner (NODE_ENV=test) a fake
 * without FAKE_PAYMENTS_WEBHOOK_SECRET accepts no webhook at all.
 */
export const FAKE_WEBHOOK_DEFAULT_SECRET = "fake-payments-secret";

/**
 * TEST ONLY: a validly signed webhook of the fake, as the route receives it (the exact body and its signature header).
 * The event carries ids and codes only.
 */
export function fakeWebhookRequest(
  event: { eventId: string; providerLinkId: string; status: ProviderLinkStatus; paidAgorot?: number; currency?: string; providerPaymentId?: string; installments?: number },
  secret: string = FAKE_WEBHOOK_DEFAULT_SECRET,
): { body: string; headers: Headers } {
  const body = JSON.stringify({
    event_id: event.eventId,
    link_id: event.providerLinkId,
    status: event.status,
    ...(event.paidAgorot === undefined ? {} : { paid_agorot: event.paidAgorot }),
    ...(event.currency === undefined ? {} : { currency: event.currency }),
    ...(event.providerPaymentId === undefined ? {} : { payment_id: event.providerPaymentId }),
    ...(event.installments === undefined ? {} : { installments: event.installments }),
  });
  return { body, headers: new Headers({ [FAKE_SIGNATURE_HEADER]: signFakeWebhook(body, secret), "content-type": "application/json" }) };
}

export type FakePaymentProvider = PaymentProvider & {
  /** Tests: the payer paid (or failed) at the fake's page. */
  settle(providerLinkId: string, status: Exclude<ProviderLinkStatus, "pending">, installments?: number): void;
};

export function createFakePaymentProvider(options: { webhookSecret?: string } = {}): FakePaymentProvider {
  const secret: string | null = options.webhookSecret ?? (process.env.NODE_ENV === "test" ? FAKE_WEBHOOK_DEFAULT_SECRET : null);
  const links = new Map<string, Link>();
  const tokens = new Map<string, CardToken>();
  const refunds = new Map<string, string>();
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
      // LNK-07: the same key answers the same refund (a retry never refunds twice)
      const known = refunds.get(request.idempotencyKey);
      if (known) return { ok: true, providerRefundId: known };
      if (!Number.isSafeInteger(request.amountAgorot) || request.amountAgorot < 1) return { ok: false, code: "amount" };
      const link = [...links.values()].find((l) => l.paymentId === request.providerPaymentId);
      if (link) {
        if (link.paidAgorot === null || request.amountAgorot > link.paidAgorot) return { ok: false, code: "not_refundable" };
      } else if (!/^fake_payment_/.test(request.providerPaymentId)) {
        // a payment the fake made in another process is not in this one's memory; the database caps the amount
        return { ok: false, code: "not_refundable" };
      }
      counter += 1;
      const id = `fake_refund_${counter}`;
      refunds.set(request.idempotencyKey, id);
      return { ok: true, providerRefundId: id };
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
      if (secret === null || !signatureMatches(input.headers.get(FAKE_SIGNATURE_HEADER), input.body, secret)) return { ok: false };
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

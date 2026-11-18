// LNK-01: the payment provider layer, one adapter per clearing provider (Tranzila, PayPlus, Cardcom, Grow; SPEC-ADDITIONS
// 7.3). A module never names a provider: it asks select.ts, so replacing one is configuration plus one adapter file. Only the
// fake adapter exists (owner (270) (1) א: built now behind a fake, hidden on the live site until a real adapter exists).
//
// LNK-03: the payment page is ALWAYS the provider's own hosted page. Nothing here carries a card number, a security code
// or an expiry typed by the payer: a request names an amount and ids; an answer names ids, codes and the page's address.
// A saved card is a provider token id with the last four digits and the expiry for display only (SPEC-ADDITIONS 16.2,
// `payment_tokens`), never the card itself. tests/unit/payment-links-providers.test.ts refuses card fields in this folder.
//
// A real adapter is called by the job worker, never from a person's request (SPEC-ADDITIONS 16.1: the provider's secret is
// not the user's): a new OPS-04 job kind that needs the owner's approval and its own "In use" line in CLAUDE.md. Its
// secrets are kept encrypted (INT-02) and read by that worker only.

/** The provider codes the database accepts (`payment_links.provider`'s check). */
export const PAYMENT_PROVIDER_CODES = ["fake"] as const;
export type PaymentProviderCode = (typeof PAYMENT_PROVIDER_CODES)[number];

export function isPaymentProviderCode(value: unknown): value is PaymentProviderCode {
  return typeof value === "string" && (PAYMENT_PROVIDER_CODES as readonly string[]).includes(value);
}

/** A link's state at the provider (the same words as `payment_links.status`). */
export type ProviderLinkStatus = "pending" | "paid" | "failed" | "expired" | "cancelled";

/** What a payment page is made for: ids and amounts only (agorot, ILS). */
export type PaymentPageRequest = {
  linkId: string;
  organizationId: string;
  amountAgorot: number;
  currency: "ILS";
  // LNK-02: card instalments the payer may choose, 1..36
  maxInstallments: number;
  // the end of the link's last day (ISO time)
  expiresAt: string;
  // the line the payer sees ("מקדמה להצעת מחיר 1001"), made by the database; never a customer's name
  title: string;
};

/** The provider's page: its id at the provider and the address to send the payer to (null = the fake, no page). */
export type PaymentPage = { providerLinkId: string; hostedUrl: string | null };

export type PaymentStatusAnswer = {
  status: ProviderLinkStatus;
  // what was paid, when paid (agorot), and the provider's id of the payment (for a refund)
  paidAgorot: number | null;
  providerPaymentId: string | null;
  installments: number | null;
};

export type RefundRequest = { providerPaymentId: string; amountAgorot: number };
export type RefundAnswer = { ok: true; providerRefundId: string } | { ok: false; code: string };

/** A saved card at the provider: its token id and display details only (never the card number). */
export type CardToken = { providerTokenId: string; last4: string; expiryMonth: number; expiryYear: number };
export type TokenPageRequest = { organizationId: string; contactId: string; title: string };
export type ChargeRequest = { providerTokenId: string; amountAgorot: number; installments: number; reference: string };
export type ChargeAnswer = { ok: true; providerPaymentId: string } | { ok: false; code: string };

/** A webhook event after its signature was checked: ids and codes only. */
export type PaymentWebhookEvent = {
  // LNK-04: the provider's own id of this event; the database takes each event once
  eventId: string;
  providerLinkId: string;
  status: ProviderLinkStatus;
  paidAgorot: number | null;
  // LNK-04 review (1): the currency of the paid amount (ISO 4217); the database takes only ILS equal to the link's amount
  currency: string | null;
  providerPaymentId: string | null;
  installments: number | null;
};

/** The raw webhook as the route got it (the body is read as text, so the signature is checked over the exact bytes). */
export type WebhookInput = { headers: Headers; body: string };

export type WebhookVerdict = { ok: true; event: PaymentWebhookEvent } | { ok: false };

/** LNK-01: the uniform layer every adapter implements. */
export interface PaymentProvider {
  readonly code: PaymentProviderCode;
  /** Make the hosted payment page for a link. */
  createPaymentPage(request: PaymentPageRequest): Promise<PaymentPage>;
  /** Ask the provider how a link stands (the sweep for a lost webhook). */
  getStatus(providerLinkId: string): Promise<PaymentStatusAnswer>;
  /** LNK-07: refund all or part of a payment. */
  refund(request: RefundRequest): Promise<RefundAnswer>;
  /** A hosted page where the payer saves a card; the answer is the token page's address. */
  createTokenPage(request: TokenPageRequest): Promise<PaymentPage>;
  /** Charge a saved card (recurring billing, SUB). */
  chargeToken(request: ChargeRequest): Promise<ChargeAnswer>;
  /** LNK-04: check a webhook's signature; an invalid one is refused before the database and its body is never logged. */
  verifyWebhook(input: WebhookInput): Promise<WebhookVerdict>;
}

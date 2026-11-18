import { createFakePaymentProvider } from "./fake";
import type { PaymentProvider, PaymentProviderCode } from "./types";

type Env = Record<string, string | undefined>;

/**
 * LNK-01: the adapters, by provider code. Only the fake exists (owner (270) (1) א). A new provider is one adapter file, one
 * line here and its code in `payment_links.provider`'s check; no module changes.
 */
const ADAPTERS: Record<PaymentProviderCode, { built: boolean; create(env: Env): PaymentProvider | null }> = {
  // LNK-04: FAKE_PAYMENTS_WEBHOOK_SECRET replaces the fake's default webhook secret (a local developer's choice; the fake
  // never runs on a Vercel production or preview deployment)
  fake: { built: true, create: (env) => createFakePaymentProvider({ webhookSecret: env.FAKE_PAYMENTS_WEBHOOK_SECRET?.trim() || undefined }) },
};

/** Adapters that may run only off Vercel or on a Vercel development environment. */
const LOCAL_ONLY = new Set<string>(["fake"]);

/**
 * The business's payment provider: PAYMENT_LINKS_PROVIDER names it. Unset, unknown or not built = none, and the payment
 * links feature is hidden (owner (270) (1) א). The fake is allowed only off Vercel or on a Vercel development environment
 * (VERCEL_ENV unset or "development"): refused on production and on preview, so the live site never offers a fake link.
 */
export function paymentProvider(env: Env = process.env): PaymentProvider | null {
  const name = (env.PAYMENT_LINKS_PROVIDER?.trim() ?? "").toLowerCase();
  if (name === "" || !Object.hasOwn(ADAPTERS, name)) return null;
  const adapter = ADAPTERS[name as PaymentProviderCode];
  if (!adapter.built) return null;
  const vercel = env.VERCEL_ENV?.trim() ?? "";
  if (LOCAL_ONLY.has(name) && !(vercel === "" || vercel === "development")) return null;
  return adapter.create(env);
}

/** The code of the provider in use, or null (the feature is hidden). Reads no secret. */
export function paymentProviderCode(env: Env = process.env): PaymentProviderCode | null {
  return paymentProvider(env)?.code ?? null;
}

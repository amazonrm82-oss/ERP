import { createFakeInvoiceProvider } from "./fake";
import type { InvoiceProvider } from "./types";

type Env = Record<string, string | undefined>;

/**
 * DOC-06: the invoice adapters, by provider code. Only "fake" exists until the owner chooses a provider (spec 6.6); a new
 * provider is one adapter file plus one line here (its `create` answers null while its own env keys are missing). A real
 * adapter needs the business's own key, stored encrypted (INT-02); reading it back for a call is a new use of the service
 * key and waits for the owner's approval (hard rule 5), so no real adapter is listed yet.
 */
type Adapter = { built: boolean; create(env: Env): InvoiceProvider | null };

const ADAPTERS: Record<string, Adapter> = {
  fake: { built: true, create: () => createFakeInvoiceProvider() },
};

/** Adapters that may run only off Vercel or on a Vercel development environment. */
const LOCAL_ONLY = new Set(["fake"]);

/**
 * The provider this deployment offers businesses: INVOICE_PROVIDER, else none. An unknown or unbuilt code is none. The fake
 * is allowed only off Vercel or on a Vercel development environment (VERCEL_ENV unset or "development"): refused on
 * production and on preview, so the live site never records a document a fake "issued" (owner (270) (1) א: hidden in
 * production). No provider = the whole feature is hidden (settings section, issue button, issue page).
 */
export function invoiceProviderFor(env: Env = process.env): InvoiceProvider | null {
  const name = (env.INVOICE_PROVIDER?.trim() ?? "").toLowerCase();
  const adapter = name !== "" && Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
  if (!adapter || !adapter.built) return null;
  const vercel = env.VERCEL_ENV?.trim() ?? "";
  if (LOCAL_ONLY.has(name) && !(vercel === "" || vercel === "development")) return null;
  return adapter.create(env);
}

/** The provider's code, or null: what screens ask before they show anything of the feature. */
export function invoiceProviderName(env: Env = process.env): string | null {
  return invoiceProviderFor(env)?.name ?? null;
}

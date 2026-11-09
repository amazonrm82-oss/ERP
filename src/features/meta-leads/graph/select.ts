import { createFakeGraphProvider } from "./fake";
import type { MetaGraphProvider } from "./types";

type Env = Record<string, string | undefined>;

/** CAP-11: the Graph adapters by code. Only "fake" until the owner sets the App ID and App Secret (owner (126) א). */
const ADAPTERS: Record<string, () => MetaGraphProvider> = {
  fake: createFakeGraphProvider,
};

/** Adapters that may run only off Vercel or on a Vercel development environment. */
const LOCAL_ONLY = new Set(["fake"]);

/**
 * The provider named by META_LEADS_PROVIDER, or null (none configured, unknown, or the fake on a Vercel production or
 * preview deployment: a deployed site never makes leads out of invented answers). No provider = the webhook still
 * records the lead ids, and they wait for the sweep.
 */
export function metaGraphProvider(env: Env = process.env): MetaGraphProvider | null {
  const name = (env.META_LEADS_PROVIDER?.trim() ?? "").toLowerCase();
  if (name === "" || !Object.hasOwn(ADAPTERS, name)) return null;
  const vercel = env.VERCEL_ENV?.trim() ?? "";
  if (LOCAL_ONLY.has(name) && !(vercel === "" || vercel === "development")) return null;
  return ADAPTERS[name]();
}

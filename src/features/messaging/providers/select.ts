import { createFakeProvider } from "./fake";
import type { MessagingProvider } from "./types";

/**
 * The provider the send handler uses, from MESSAGING_PROVIDER. Only "fake" exists (OPS-04: no real provider until the
 * owner chooses one), and it is allowed only off Vercel or on a Vercel development environment (VERCEL_ENV unset or
 * "development"): refused on production and on preview, so queued messages of a deployed site are never marked sent by
 * a fake. No provider = the message.send kind is not registered and its jobs wait in the queue.
 */
export function messagingProvider(env: Record<string, string | undefined> = process.env): MessagingProvider | null {
  const name = env.MESSAGING_PROVIDER?.trim();
  const vercel = env.VERCEL_ENV?.trim() ?? "";
  if (name === "fake" && (vercel === "" || vercel === "development")) return createFakeProvider();
  return null;
}

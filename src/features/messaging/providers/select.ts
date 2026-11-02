import { createFakeProvider } from "./fake";
import type { MessagingProvider } from "./types";

/**
 * The provider the send handler uses, from MESSAGING_PROVIDER. Only "fake" exists (OPS-04: no real provider until the
 * owner chooses one), and it is refused on a production deployment (VERCEL_ENV=production), so live queued messages are
 * never marked sent by a fake. No provider = the message.send kind is not registered and its jobs wait in the queue.
 */
export function messagingProvider(env: Record<string, string | undefined> = process.env): MessagingProvider | null {
  const name = env.MESSAGING_PROVIDER?.trim();
  if (name === "fake" && env.VERCEL_ENV !== "production") return createFakeProvider();
  return null;
}

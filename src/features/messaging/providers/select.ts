import { createFakeProvider } from "./fake";
import { createInforuProvider } from "./inforu";
import { createSms4FreeProvider } from "./sms4free";
import { MESSAGE_CHANNELS, type MessageChannel, type MessagingProvider } from "./types";

type Env = Record<string, string | undefined>;

/**
 * MSG-01: the adapters, by provider code. Only "fake" sends (no real provider until the owner chooses one); a new
 * provider is one adapter file plus one line here, and no module changes. Each adapter says which channels it serves.
 * SMS-01: SMS4Free is a stub (built: false): never chosen, whatever the env says. SMS-05: InforU is built (owner (318) א);
 * an adapter without its own env keys is none, so the SMS channel's jobs wait in the queue unclaimed until the keys are set.
 */
type Adapter = { channels: readonly MessageChannel[]; built: boolean; create(channel: MessageChannel, env: Env): MessagingProvider | null };

const ADAPTERS: Record<string, Adapter> = {
  fake: { channels: MESSAGE_CHANNELS, built: true, create: (channel) => createFakeProvider({ channel }) },
  // SMS-05 (owner (318) א): InforU is built; without its keys it is still no provider (createInforuProvider answers null)
  inforu: { channels: ["sms"], built: true, create: (_channel, env) => createInforuProvider(env) },
  sms4free: { channels: ["sms"], built: false, create: (_channel, env) => createSms4FreeProvider(env) },
};

/** Adapters that may run only off Vercel or on a Vercel development environment. */
const LOCAL_ONLY = new Set(["fake"]);

/** The env variable that names a channel's provider: MESSAGING_PROVIDER_EMAIL, _SMS, _WHATSAPP. */
export function providerEnvKey(channel: MessageChannel): string {
  return `MESSAGING_PROVIDER_${channel.toUpperCase()}`;
}

/**
 * The provider of one channel: MESSAGING_PROVIDER_<CHANNEL>, else MESSAGING_PROVIDER (one provider for every channel it
 * serves). An unknown code, or an adapter that does not serve the channel, is no provider. The fake is allowed only off
 * Vercel or on a Vercel development environment (VERCEL_ENV unset or "development"): refused on production and on
 * preview, so queued messages of a deployed site are never marked sent by a fake. No provider = that channel's jobs are
 * not sent (send-handler.ts).
 */
export function messagingProviderFor(channel: MessageChannel, env: Env = process.env): MessagingProvider | null {
  const name = (env[providerEnvKey(channel)]?.trim() || env.MESSAGING_PROVIDER?.trim() || "").toLowerCase();
  const adapter = name === "" ? undefined : Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name] : undefined;
  if (!adapter || !adapter.built || !adapter.channels.includes(channel)) return null;
  const vercel = env.VERCEL_ENV?.trim() ?? "";
  if (LOCAL_ONLY.has(name) && !(vercel === "" || vercel === "development")) return null;
  return adapter.create(channel, env);
}

/** Every channel's provider, read once per run. Channels without one are left out. */
export function messagingProviders(env: Env = process.env): Partial<Record<MessageChannel, MessagingProvider>> {
  const out: Partial<Record<MessageChannel, MessagingProvider>> = {};
  for (const channel of MESSAGE_CHANNELS) {
    const provider = messagingProviderFor(channel, env);
    if (provider) out[channel] = provider;
  }
  return out;
}

/** OPS-04's name, kept for callers: the provider of the email channel. */
export function messagingProvider(env: Env = process.env): MessagingProvider | null {
  return messagingProviderFor("email", env);
}

import { smsSenderNameOk } from "../sms-sender";
import type { MessagingProvider, ProviderResult } from "./types";

type Env = Record<string, string | undefined>;

/**
 * SMS-01: what an SMS adapter of a real provider (InforU, SMS4Free) shares. No provider is chosen yet, so both adapters
 * are stubs: each reads ONLY its own env keys (the platform account, set by the owner in Vercel; never a business's
 * secret), refuses to start without them (null), and is marked not built in select.ts, so it is never chosen and the SMS
 * channel's jobs wait in the queue unclaimed. When the owner chooses a provider, its adapter is written here and in its
 * file, and the sender path that reads what it sends gets its own approved "In use" line (hard rule 5, wave 3 use (1)).
 */
export type SmsStubSpec = {
  name: string;
  // the env keys the platform account needs, all required
  keys: readonly string[];
  // the env key of the platform account's default sender (used when the business set none)
  defaultSenderKey: string;
};

/**
 * The sender a message goes out under. `effectiveSender` is ONLY the answer of app.sms_effective_sender (SMS-01b: an
 * approved letter name, else the business's verified own number, else null), never the raw org_message_settings
 * sms_sender_name, which may still wait for the provider's approval or a verification. Then the platform's default, else none.
 */
export function smsSenderFor(effectiveSender: string | null | undefined, platformDefault: string | null | undefined): string | null {
  if (smsSenderNameOk(effectiveSender ?? null)) return effectiveSender as string;
  const fallback = platformDefault?.trim() ?? "";
  return smsSenderNameOk(fallback) ? fallback : null;
}

/** Whether every key of the account is set (non-empty). */
export function smsAccountReady(spec: SmsStubSpec, env: Env): boolean {
  return spec.keys.every((key) => (env[key]?.trim() ?? "") !== "");
}

const NOT_BUILT: ProviderResult = { ok: false, error: "the adapter is not built yet", code: "adapter_not_built", final: false };

/**
 * A stub adapter: null without its keys; with them, an adapter that sends nothing and answers a retryable failure (never
 * reached in practice, because select.ts does not choose an adapter that is not built).
 */
export function createSmsStub(spec: SmsStubSpec, env: Env): MessagingProvider | null {
  if (!smsAccountReady(spec, env)) return null;
  return {
    name: spec.name,
    channel: "sms",
    async send() {
      return NOT_BUILT;
    },
  };
}

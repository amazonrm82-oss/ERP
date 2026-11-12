/**
 * LND-20 owner (339) ב: a built capability that still waits for its real provider is marked "בקרוב" on the landing page. Read
 * on the server from the provider configuration only (never a hand list of features); the page passes on booleans, never an
 * env value. Pure (env in, booleans out), and kept equal to the real selectors by tests/unit/landing-provider-readiness.test.ts,
 * which compares it with messagingProviderFor() and metaGraphProvider() (the selectors are not imported here, so the page does
 * not load every adapter). The InforU account keys are read only by the adapter (owner (318) א): it answers a boolean.
 */
import { inforuAccountReady } from "@/features/messaging/providers/inforu";

type Env = Record<string, string | undefined>;

const filled = (env: Env, key: string) => (env[key]?.trim() ?? "") !== "";
const providerName = (env: Env, channel: "email" | "sms") =>
  (env[`MESSAGING_PROVIDER_${channel.toUpperCase()}`]?.trim() || env.MESSAGING_PROVIDER?.trim() || "").toLowerCase();

type Ready = (env: Env) => boolean;
/** The real (built, not fake) SMS adapters and their own "configured" check: InforU only (SMS-05). */
export const REAL_SMS_PROVIDERS: Readonly<Record<string, Ready>> = { inforu: (env) => inforuAccountReady(env) };
/** The real email adapters: none is built yet (MSG-01 has only the fake). */
export const REAL_EMAIL_PROVIDERS: Readonly<Record<string, Ready>> = {};
/** The real Meta Graph adapters: none is built yet (CAP-11 has only the fake). */
export const REAL_META_PROVIDERS: Readonly<Record<string, Ready>> = {};
/** What the Meta webhook itself needs beside the Graph adapter (route /api/meta/leads, INT-02's key for the page token). */
export const META_WEBHOOK_KEYS = ["META_APP_SECRET", "META_VERIFY_TOKEN", "PROVIDER_SECRETS_KEY"] as const;

function realReady(table: Readonly<Record<string, Ready>>, name: string, env: Env): boolean {
  return name !== "" && Object.hasOwn(table, name) && table[name](env);
}

export type ProviderReadiness = { sms: boolean; email: boolean; meta: boolean };

export function providerReadiness(env: Env = process.env): ProviderReadiness {
  const meta = (env.META_LEADS_PROVIDER?.trim() ?? "").toLowerCase();
  return {
    sms: realReady(REAL_SMS_PROVIDERS, providerName(env, "sms"), env),
    email: realReady(REAL_EMAIL_PROVIDERS, providerName(env, "email"), env),
    meta: realReady(REAL_META_PROVIDERS, meta, env) && META_WEBHOOK_KEYS.every((key) => filled(env, key)),
  };
}

/** The plan capabilities (PLAN_CAPABILITIES feature keys) that are built but wait for a provider, from the readiness. */
export function waitingForProvider(ready: ProviderReadiness): string[] {
  const out: string[] = [];
  if (!ready.meta) out.push("meta_leads");
  if (!ready.sms) out.push("sms");
  // meeting messages and review requests go out by SMS or by email: waiting while neither has a real provider
  if (!ready.sms && !ready.email) out.push("meeting_reminders", "review_requests");
  return out;
}

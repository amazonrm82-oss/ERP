import { createSmsStub, type SmsStubSpec } from "./sms-stub";

type Env = Record<string, string | undefined>;

/**
 * SMS-01: InforU (SMS), a stub until the owner chooses a provider. The platform account's keys: INFORU_USERNAME,
 * INFORU_API_TOKEN, and the default sender INFORU_SENDER (set by the owner in Vercel; this file is the only reader).
 */
export const INFORU: SmsStubSpec = { name: "inforu", keys: ["INFORU_USERNAME", "INFORU_API_TOKEN"], defaultSenderKey: "INFORU_SENDER" };

export function createInforuProvider(env: Env = process.env) {
  return createSmsStub(INFORU, env);
}

import { createSmsStub, type SmsStubSpec } from "./sms-stub";

type Env = Record<string, string | undefined>;

/**
 * SMS-01: SMS4Free (SMS), a stub until the owner chooses a provider. The platform account's keys: SMS4FREE_KEY,
 * SMS4FREE_USER, SMS4FREE_PASS, and the default sender SMS4FREE_SENDER (set by the owner in Vercel; this file is the only
 * reader).
 */
export const SMS4FREE: SmsStubSpec = { name: "sms4free", keys: ["SMS4FREE_KEY", "SMS4FREE_USER", "SMS4FREE_PASS"], defaultSenderKey: "SMS4FREE_SENDER" };

export function createSms4FreeProvider(env: Env = process.env) {
  return createSmsStub(SMS4FREE, env);
}

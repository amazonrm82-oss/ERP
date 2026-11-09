import "server-only";

import { parseSecretKey, type SecretKey } from "./crypto";

type Env = Record<string, string | undefined>;

/**
 * INT-02: the current key (PROVIDER_SECRETS_KEY, PROVIDER_SECRETS_KEY_VERSION) and, only while a key is being replaced, the
 * previous one (PROVIDER_SECRETS_KEY_PREVIOUS, PROVIDER_SECRETS_KEY_PREVIOUS_VERSION). No key = secrets are neither stored
 * nor read; never a fallback to a plain value.
 */
export function currentSecretKey(env: Env = process.env): SecretKey | null {
  return parseSecretKey(env.PROVIDER_SECRETS_KEY, env.PROVIDER_SECRETS_KEY_VERSION);
}

export function previousSecretKey(env: Env = process.env): SecretKey | null {
  const key = parseSecretKey(env.PROVIDER_SECRETS_KEY_PREVIOUS, env.PROVIDER_SECRETS_KEY_PREVIOUS_VERSION);
  const current = currentSecretKey(env);
  // the same version under two keys would make an envelope ambiguous
  return key && current && key.version === current.version ? null : key;
}

/** Every key a stored envelope may be under: the current one, then the previous one. */
export function secretKeyring(env: Env = process.env): SecretKey[] {
  return [currentSecretKey(env), previousSecretKey(env)].filter((k): k is SecretKey => k !== null);
}

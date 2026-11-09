import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * INT-02 (owner, 26 October 2026, answer (א)): a provider secret is encrypted on the server with AES-256-GCM under a key the
 * owner sets as the Vercel env var PROVIDER_SECRETS_KEY; the database keeps only the envelope this file makes.
 *
 * Envelope: `ps1.<key version>.<iv>.<ciphertext>.<tag>` (base64url; a 12-byte random iv, a 16-byte tag). The additional data
 * binds it to its business, its connection and the connection's external id (a Meta page id; review finding 1), so a value
 * copied onto another row, or kept after the row named another page, does not decrypt. Never logged, never sent
 * to a browser: callers keep the plain value only for the one provider call that needs it.
 */

export type SecretKey = { version: number; key: Buffer };
/** externalId: the connection's external id (the Meta page id), "" for a provider without one. */
export type SecretContext = { organizationId: string; integrationId: string; externalId: string };

export class SecretError extends Error {
  constructor(public readonly code: "no_key" | "bad_key" | "bad_envelope" | "unknown_version" | "decrypt_failed" | "too_long") {
    super(code);
    this.name = "SecretError";
  }
}

const PREFIX = "ps1";
const ENVELOPE = /^ps1\.([0-9]{1,4})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{1,12000})\.([A-Za-z0-9_-]{22})$/;
/** The longest plain secret kept (bytes); the database's envelope check allows its ciphertext. */
export const MAX_SECRET_BYTES = 8000;

const additionalData = (context: SecretContext) =>
  Buffer.from(`crm-provider-secret:v1:${context.organizationId}:${context.integrationId}:${context.externalId}`, "utf8");

/**
 * The key from its env values: 32 bytes as base64 (or base64url), and a version 1..9999 (default 1). Anything else is no
 * key (null): a caller then refuses to store a secret, never stores it plain.
 */
export function parseSecretKey(raw: string | undefined, versionRaw?: string | undefined): SecretKey | null {
  const value = raw?.trim() ?? "";
  if (value === "" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  const key = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== 32) return null;
  const versionText = versionRaw?.trim() || "1";
  if (!/^[0-9]{1,4}$/.test(versionText)) return null;
  const version = Number(versionText);
  if (version < 1) return null;
  return { version, key };
}

/** The key version an envelope names, or null when it is not an envelope. */
export function envelopeVersion(envelope: string): number | null {
  const match = ENVELOPE.exec(envelope);
  return match ? Number(match[1]) : null;
}

export function encryptSecret(plain: string, key: SecretKey | null, context: SecretContext): string {
  if (!key) throw new SecretError("no_key");
  if (key.key.length !== 32) throw new SecretError("bad_key");
  const data = Buffer.from(plain, "utf8");
  if (data.length === 0 || data.length > MAX_SECRET_BYTES) throw new SecretError("too_long");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.key, iv);
  cipher.setAAD(additionalData(context));
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, String(key.version), iv.toString("base64url"), body.toString("base64url"), tag.toString("base64url")].join(".");
}

/** Decrypts with the key of the envelope's version, among the keys given. Throws SecretError (never the value). */
export function decryptSecret(envelope: string, keys: readonly (SecretKey | null)[], context: SecretContext): string {
  const match = ENVELOPE.exec(envelope);
  if (!match) throw new SecretError("bad_envelope");
  const version = Number(match[1]);
  const key = keys.find((k): k is SecretKey => k !== null && k.version === version);
  if (!key) throw new SecretError("unknown_version");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.key, Buffer.from(match[2], "base64url"));
    decipher.setAAD(additionalData(context));
    decipher.setAuthTag(Buffer.from(match[4], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(match[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError("decrypt_failed");
  }
}

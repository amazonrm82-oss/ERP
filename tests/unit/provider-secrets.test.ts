import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, envelopeVersion, parseSecretKey, SecretError } from "@/features/integrations/crypto";
import { currentSecretKey, previousSecretKey, secretKeyring } from "@/features/integrations/keys-server";

const keyText = () => randomBytes(32).toString("base64");
const ctx = { organizationId: "11111111-1111-4111-8111-111111111111", integrationId: "22222222-2222-4222-8222-222222222222", externalId: "1001" };
// the database's check on app.integration_secrets.ciphertext (migration _provider_secrets.sql)
const DB_SHAPE = /^ps1\.[0-9]{1,4}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,12000}\.[A-Za-z0-9_-]{22}$/;

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as SecretError).code;
  }
  return "ok";
};

describe("INT-02: provider secrets are encrypted with AES-256-GCM", () => {
  it("decrypts an envelope of the previous key while a key is being replaced (owner (146) ג: the procedure's step 1)", () => {
    const oldText = keyText();
    const oldKey = parseSecretKey(oldText, "1");
    const envelope = encryptSecret("old-token", oldKey, ctx);
    const env = { PROVIDER_SECRETS_KEY: keyText(), PROVIDER_SECRETS_KEY_VERSION: "2", PROVIDER_SECRETS_KEY_PREVIOUS: oldText, PROVIDER_SECRETS_KEY_PREVIOUS_VERSION: "1" };
    expect(decryptSecret(envelope, secretKeyring(env), ctx)).toBe("old-token");
    // without the previous key it no longer opens
    expect(code(() => decryptSecret(envelope, secretKeyring({ PROVIDER_SECRETS_KEY: env.PROVIDER_SECRETS_KEY, PROVIDER_SECRETS_KEY_VERSION: "2" }), ctx))).toBe("unknown_version");
  });

  it("reads a 32-byte key with its version, and nothing else", () => {
    expect(parseSecretKey(keyText())?.version).toBe(1);
    expect(parseSecretKey(keyText(), "7")?.version).toBe(7);
    expect(parseSecretKey(randomBytes(32).toString("base64url"))?.key.length).toBe(32);
    expect(parseSecretKey(undefined)).toBeNull();
    expect(parseSecretKey("")).toBeNull();
    expect(parseSecretKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(parseSecretKey("not a key!")).toBeNull();
    expect(parseSecretKey(keyText(), "0")).toBeNull();
    expect(parseSecretKey(keyText(), "v2")).toBeNull();
  });

  it("round-trips, never holds the plain value, and fits the database's shape", () => {
    const key = parseSecretKey(keyText(), "3");
    const secret = "EAAB-page-token-שלום-123";
    const envelope = encryptSecret(secret, key, ctx);
    expect(envelope).toMatch(DB_SHAPE);
    expect(envelope).not.toContain(secret);
    expect(envelope).not.toContain(Buffer.from(secret).toString("base64url"));
    expect(envelopeVersion(envelope)).toBe(3);
    expect(decryptSecret(envelope, [key], ctx)).toBe(secret);
    // a fresh iv each time
    expect(encryptSecret(secret, key, ctx)).not.toBe(envelope);
  });

  it("refuses to encrypt without a key (never stores it plain)", () => {
    expect(code(() => encryptSecret("x", null, ctx))).toBe("no_key");
    expect(code(() => encryptSecret("", parseSecretKey(keyText()), ctx))).toBe("too_long");
    expect(code(() => encryptSecret("x".repeat(8001), parseSecretKey(keyText()), ctx))).toBe("too_long");
    // the longest secret still fits the database's check
    expect(encryptSecret("x".repeat(8000), parseSecretKey(keyText()), ctx)).toMatch(DB_SHAPE);
  });

  it("does not decrypt on another row, with another key, or when changed", () => {
    const key = parseSecretKey(keyText());
    const envelope = encryptSecret("secret", key, ctx);
    const other = "33333333-3333-4333-8333-333333333333";
    expect(code(() => decryptSecret(envelope, [key], { ...ctx, integrationId: other }))).toBe("decrypt_failed");
    expect(code(() => decryptSecret(envelope, [key], { ...ctx, organizationId: other }))).toBe("decrypt_failed");
    // review finding 1: the page id is bound too
    expect(code(() => decryptSecret(envelope, [key], { ...ctx, externalId: "1002" }))).toBe("decrypt_failed");
    expect(code(() => decryptSecret(envelope, [parseSecretKey(keyText())], ctx))).toBe("decrypt_failed");
    expect(code(() => decryptSecret(envelope, [parseSecretKey(keyText(), "2")], ctx))).toBe("unknown_version");
    const parts = envelope.split(".");
    parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
    expect(code(() => decryptSecret(parts.join("."), [key], ctx))).toBe("decrypt_failed");
    expect(code(() => decryptSecret("plain-token", [key], ctx))).toBe("bad_envelope");
  });

  it("reads the keyring from the env; the previous key only with another version", () => {
    const env = { PROVIDER_SECRETS_KEY: keyText(), PROVIDER_SECRETS_KEY_VERSION: "2", PROVIDER_SECRETS_KEY_PREVIOUS: keyText() };
    expect(currentSecretKey(env)?.version).toBe(2);
    expect(previousSecretKey(env)?.version).toBe(1);
    expect(secretKeyring(env).map((k) => k.version)).toEqual([2, 1]);
    expect(previousSecretKey({ ...env, PROVIDER_SECRETS_KEY_VERSION: "1" })).toBeNull();
    expect(currentSecretKey({})).toBeNull();
    expect(secretKeyring({})).toEqual([]);
  });
});

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * CAP-11 (owner (126) א): the two checks the Meta webhook makes before anything else. Both are pure, read only what
 * they are given and never log it.
 */

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

/**
 * True when X-Hub-Signature-256 is "sha256=<hex>" of the HMAC-SHA256 of the RAW body with the App Secret. Compared
 * timing-safe over equal-length digests; an empty secret, a missing or malformed header never matches.
 */
export function metaSignatureValid(rawBody: Uint8Array, header: string | null | undefined, appSecret: string | null | undefined): boolean {
  const secret = appSecret?.trim() ?? "";
  const match = SIGNATURE.exec((header ?? "").trim().toLowerCase());
  if (secret === "" || !match) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const CHALLENGE = /^[A-Za-z0-9._-]{1,256}$/;

/**
 * The GET verification: the challenge to answer, only for hub.mode=subscribe with hub.verify_token equal to the secret
 * verify token (compared timing-safe through hashes, so the length is not told), and a challenge of plain characters;
 * else null.
 */
export function metaChallenge(params: URLSearchParams, verifyToken: string | null | undefined): string | null {
  const wanted = verifyToken?.trim() ?? "";
  if (wanted === "" || params.get("hub.mode") !== "subscribe") return null;
  const given = params.get("hub.verify_token") ?? "";
  const same = timingSafeEqual(createHash("sha256").update(given, "utf8").digest(), createHash("sha256").update(wanted, "utf8").digest());
  const challenge = params.get("hub.challenge") ?? "";
  return same && CHALLENGE.test(challenge) ? challenge : null;
}

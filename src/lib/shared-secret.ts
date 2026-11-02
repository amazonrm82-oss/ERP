import { createHash, timingSafeEqual } from "node:crypto";

/**
 * True when an Authorization header is "Bearer <secret>" with exactly the expected secret. Both sides are hashed first,
 * so the comparison takes the same time whatever the length of the given value. An empty expected secret never
 * matches (a route without its secret is not configured; it answers 503 before asking this).
 */
export function bearerSecretMatches(authorization: string | null | undefined, expected: string | null | undefined): boolean {
  const secret = expected?.trim() ?? "";
  const header = authorization ?? "";
  if (secret === "" || !header.startsWith("Bearer ")) return false;
  const given = createHash("sha256").update(header.slice(7), "utf8").digest();
  const wanted = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(given, wanted);
}

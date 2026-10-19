import "server-only";

import { createHmac } from "node:crypto";

// FXS-11 (owner, 13 October 2026): a public page keeps a sender's IP only as a keyed hash, made with the server's
// secret INTAKE_IP_HASH_SECRET, and only for its rate-limit window (the database clears it: crm-form-ip-hashes,
// crm-booking-ip-hashes). Without the secret no hash is kept and a clear error is logged; there is never a fallback
// to a plain hash. Changing the secret only restarts the rate-limit windows.

/** Each public page hashes in its own scope, so one visitor is a different value on each kind of page. */
export type IpHashScope = "intake" | "booking" | "card" | "widget" | "waitlist";

const missingLogged = new Set<string>();

/** The sender's address from the proxy's headers (Vercel sets x-forwarded-for). */
export function clientIp(headers: Headers): string | null {
  const forwarded = headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || headers.get("x-real-ip") || null;
}

/**
 * HMAC-SHA256 of `<scope>:<part>:…:<ip>` with the secret, or null (no address, or no secret: logged). `parts` narrow
 * the scope further (a form's token), so the same visitor on two forms gives two values.
 */
export function keyedIpHash(ip: string | null, scope: IpHashScope, ...parts: string[]): string | null {
  if (!ip) return null;
  const secret = process.env.INTAKE_IP_HASH_SECRET;
  if (!secret) {
    // once per scope and process, so a busy page does not flood the log
    if (!missingLogged.has(scope)) {
      missingLogged.add(scope);
      console.error(`[FXS-11 ${scope}] INTAKE_IP_HASH_SECRET is not set: no IP hash kept, only the per-page rate limits apply`);
    }
    return null;
  }
  return createHmac("sha256", secret).update([scope, ...parts, ip].join(":")).digest("hex");
}

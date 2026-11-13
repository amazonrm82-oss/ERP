import "server-only";

import { headers } from "next/headers";

import { publicSenderAddress } from "@/lib/ip-prefix";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { createServiceClient } from "@/lib/supabase/service";

// USR-13 (owner, 13 November 2026, answers (364) א and (370) א; CLAUDE.md hard rule 5): after 5 failed sign-ins for the
// same address the address is locked for 15 minutes, and 50 failures from one sender across addresses lock the sender for
// 15 minutes. Each try is reserved BEFORE Auth is asked (a parallel burst cannot pass the limit) and given back when Auth
// failed for another reason. This file is the ONLY caller of public.login_guard() (service_role only) and calls nothing else with the
// service key. It sends only two keyed hashes, both HMAC-SHA256 with the IP hash secret through src/lib/keyed-ip-hash.ts:
// the sender's address (scope `login`; an IPv6 sender by its /64, as OPS-02) and the typed address, trimmed and lower case
// (scope `login-email`). Never the plain address, the IP, the password or the request body. The same secret as every
// public page: it is already server-only, the database never sees it, and replacing it only restarts the windows.
// Fail open (never locked out by our own fault): without the secret, the service key, or when the database cannot be asked,
// nothing is checked or counted, and one redacted line is logged per reason and process.

export type LoginGuardEvent = "attempt" | "success" | "release";

type Hashes = { email: string | null; ip: string | null };

const loggedReasons = new Set<string>();

async function logOnce(reason: string, code?: string): Promise<void> {
  if (loggedReasons.has(reason)) return;
  loggedReasons.add(reason);
  await serverLog(reason === "rpc_failed" ? "error" : "warn", "auth.login_guard_off", { reason, code });
}

/** The two keyed hashes of a sign-in: the typed address (trimmed, lower case) and the sender. Null when there is no secret. */
export function loginHashes(email: string, ip: string | null): Hashes {
  const normalized = email.trim().toLowerCase();
  return {
    // keyedIpHash hashes `<scope>:<value>` with the secret; here the value is the address, never kept plain
    email: normalized ? keyedIpHash(normalized, "login-email") : null,
    ip: keyedIpHash(publicSenderAddress(ip), "login"),
  };
}

/** The windows the reserved tries were counted in (from 'attempt'; not secret), handed back with the outcome. */
export type LoginReservation = { locked: boolean; emailWindow: string | null; ipWindow: string | null };

const OPEN: LoginReservation = { locked: false, emailWindow: null, ipWindow: null };
const WINDOW = /^[0-9T:.+\- ]{10,40}$/;
const windowOf = (value: unknown): string | null => (typeof value === "string" && WINDOW.test(value) ? value : null);

async function guard(email: string, event: LoginGuardEvent, reservation: LoginReservation = OPEN): Promise<LoginReservation> {
  const hashes = loginHashes(email, clientIp(await headers()));
  if (!hashes.email && !hashes.ip) {
    // keyed-ip-hash already logs the missing secret once per scope
    await logOnce("no_hash");
    return OPEN;
  }
  // nothing was reserved (no hash, no key, a failed call): nothing to give back
  if (event !== "attempt" && !reservation.emailWindow && !reservation.ipWindow) return OPEN;
  const service = createServiceClient();
  if (!service) {
    await logOnce("service_key_not_set");
    return OPEN;
  }
  try {
    const { data, error } = await service.rpc("login_guard", {
      p_email_hash: hashes.email,
      p_ip_hash: hashes.ip,
      p_event: event,
      p_email_window: reservation.emailWindow,
      p_ip_window: reservation.ipWindow,
    });
    if (error) {
      await logOnce("rpc_failed", error.code);
      return OPEN;
    }
    const answer = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
    return { locked: answer.locked === true, emailWindow: windowOf(answer.email_window), ipWindow: windowOf(answer.ip_window) };
  } catch {
    await logOnce("rpc_failed");
    return OPEN;
  }
}

/**
 * Before the sign-in: takes one try of the address and of the sender under their row locks (so a burst of parallel tries
 * gets at most 5 through for one address). `locked` = nothing taken, Auth must not be asked; else the reservation is handed
 * back with the outcome.
 */
export async function reserveLoginAttempt(email: string): Promise<LoginReservation> {
  return guard(email, "attempt");
}

/**
 * After the sign-in: "success" clears the address's count and gives the sender's try back; "release" gives both tries back
 * when Auth failed for another reason than a wrong address or password. Only tries of the reservation's own windows are
 * touched. A wrong password needs no call: its try stays counted.
 */
export async function recordLoginOutcome(email: string, outcome: "success" | "release", reservation: LoginReservation): Promise<void> {
  await guard(email, outcome, reservation);
}

/** Only Auth's own "wrong address or password" answer counts as a failed sign-in; a network error, a 5xx or a 429 never does. */
export function isInvalidCredentials(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; status?: unknown; message?: unknown };
  if (e.code === "invalid_credentials") return true;
  return e.status === 400 && typeof e.message === "string" && /invalid login credentials/i.test(e.message);
}

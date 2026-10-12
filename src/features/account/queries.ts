import "server-only";

import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";
import { needsSecondStep } from "@/lib/errors";

export type SessionItem = { id: string; createdAt: string; lastActiveAt: string; userAgent: string | null; ip: string | null; isCurrent: boolean };

/** The device list, or "second step needed" when this session has not passed it (RVW-13). */
export type SessionsResult = { ok: true; sessions: SessionItem[] } | { ok: false; reason: "second_step" };

export async function listMySessions(): Promise<SessionsResult> {
  const supabase = await createClient();
  const result = await supabase.rpc("my_sessions");
  if (result.error && needsSecondStep(result.error)) {
    return { ok: false, reason: "second_step" };
  }
  const data = must(result, "my_sessions");
  return { ok: true, sessions: parseSessions(data) };
}

/** The rows of my_sessions(), shaped for the page. */
export function parseSessions(data: unknown): SessionItem[] {
  const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    createdAt: String(r.created_at),
    lastActiveAt: String(r.last_active_at),
    userAgent: typeof r.user_agent === "string" ? r.user_agent : null,
    ip: typeof r.ip === "string" ? r.ip : null,
    isCurrent: r.is_current === true,
  }));
}

/** "Chrome on Windows" from a user agent, roughly. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "מכשיר לא מזוהה";
  const browser = /Edg\//.test(userAgent) ? "Edge" : /Chrome\//.test(userAgent) ? "Chrome" : /Firefox\//.test(userAgent) ? "Firefox" : /Safari\//.test(userAgent) ? "Safari" : "דפדפן";
  const os = /iPhone|iPad/.test(userAgent) ? "iPhone" : /Android/.test(userAgent) ? "Android" : /Windows/.test(userAgent) ? "Windows" : /Mac OS X/.test(userAgent) ? "Mac" : /Linux/.test(userAgent) ? "Linux" : "";
  return os ? `${browser} ב-${os}` : browser;
}

/** How many unused backup codes the signed-in user has left (0 without two-step verification). */
export async function getRecoveryCodesLeft(): Promise<number> {
  const supabase = await createClient();
  const result = await supabase.rpc("mfa_recovery_codes_status");
  // RVW-13: a session that has not passed the second step is not told; it has
  // no codes to manage from here (the factor needs that step first anyway)
  if (result.error && needsSecondStep(result.error)) {
    return 0;
  }
  const data = must(result, "mfa_recovery_codes_status");
  const status = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return typeof status.remaining === "number" ? status.remaining : 0;
}

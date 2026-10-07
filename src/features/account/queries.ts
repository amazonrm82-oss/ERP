import "server-only";

import { createClient } from "@/lib/supabase/server";

export type SessionItem = { id: string; createdAt: string; lastActiveAt: string; userAgent: string | null; ip: string | null; isCurrent: boolean };

export async function listMySessions(): Promise<SessionItem[]> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("my_sessions");
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

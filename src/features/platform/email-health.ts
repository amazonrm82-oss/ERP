import { formatNumber } from "@/lib/format";

// EML-01, owner's answer (7) ב (13 November 2026; the lead's reading in DECISIONS.md): emails stopped because Resend refused
// our key show as a warning on the platform panel's dashboard. Counts only (public.platform_email_health).

export type EmailHealth = { keyRefused24h: number; lastKeyRefusedAt: string | null };

/** The answer of public.platform_email_health(), read strictly (anything unexpected = nothing to warn about). */
export function parseEmailHealth(data: unknown): EmailHealth {
  const row = data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const count = Number(row.key_refused_24h);
  const last = row.last_key_refused_at;
  return {
    keyRefused24h: Number.isInteger(count) && count > 0 ? count : 0,
    lastKeyRefusedAt: typeof last === "string" && last !== "" ? last : null,
  };
}

// The variable's name is not written here: only the adapter may name the Resend settings (unit scan, eslint).
/** The dashboard's warning line, or null when no email was stopped by a refused key in the last 24 hours. */
export function emailKeyRefusedText(health: EmailHealth): string | null {
  if (health.keyRefused24h <= 0) return null;
  const stopped = health.keyRefused24h === 1 ? "מייל אחד לא נשלח" : `${formatNumber(health.keyRefused24h)} מיילים לא נשלחו`;
  return `Resend דחה את מפתח השליחה: ${stopped} ב-24 השעות האחרונות. בדקו את מפתח ה-API של Resend בהגדרות הסביבה ב-Vercel.`;
}

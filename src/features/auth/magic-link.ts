// USR-10 (owner (389) ג): sign-in by a one-time link to the email (Supabase Auth's signInWithOtp, sent through the project's
// SMTP). Pure rules shared by the action and its tests; no Supabase call here.
// The page is told MAGIC_LINK_SENT after every Auth answer (lead's choice and the independent review, 16 November 2026): "no
// such user", a send failure, every rate limit; only the log carries the real code. The answer also takes the same time
// (./answer-floor.ts).

/** The one answer for every address and every Auth outcome (never tells whether the address has an account). */
export const MAGIC_LINK_SENT = "אם הכתובת רשומה אצלנו, שלחנו אליה קישור כניסה. הקישור תקף לזמן קצר.";

/** The callback the link returns to: always carries `next` (so an email template may append `&token_hash=…&type=magiclink`). */
export function magicLinkRedirect(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

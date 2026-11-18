import { DOCUMENT_TYPE_LABELS } from "@/features/documents/schema";

/**
 * DOC-16: the invoice provider connection's sync log (public.invoice_provider_events). kind is a closed list (the table's
 * check constraint); code is the provider's or the server's short code. An unknown code falls back to the kind's own line.
 */

export const INVOICE_PROVIDER_EVENT_KINDS = [
  "connected",
  "disconnected",
  "check_ok",
  "check_failed",
  "issued",
  "retry",
  "failed",
  "unrecorded",
  "closed",
  "checked",
  "stale",
] as const;
export type InvoiceProviderEventKind = (typeof INVOICE_PROVIDER_EVENT_KINDS)[number];

export type EventTone = "neutral" | "success" | "warning" | "danger";

const KIND_TEXT: Record<InvoiceProviderEventKind, { text: string; tone: EventTone }> = {
  connected: { text: "העסק חובר לספק", tone: "success" },
  disconnected: { text: "החיבור לספק נותק", tone: "neutral" },
  check_ok: { text: "בדיקת חיבור: תקין", tone: "success" },
  check_failed: { text: "בדיקת החיבור נכשלה", tone: "danger" },
  issued: { text: "מסמכים הופקו ונרשמו", tone: "success" },
  retry: { text: "הספק לא ענה, ננסה שוב", tone: "warning" },
  failed: { text: "הספק סירב להפיק מסמך", tone: "warning" },
  unrecorded: { text: "בקשה הסתיימה בלי רישום", tone: "danger" },
  closed: { text: "בקשת הפקה נסגרה ביד", tone: "neutral" },
  checked: { text: "בקשה סומנה כנבדקה אצל הספק", tone: "neutral" },
  stale: { text: "בקשת הפקה המתינה יותר מיממה", tone: "warning" },
};

const CODE_TEXT: Record<string, string> = {
  timeout: "הספק לא ענה בזמן",
  unreachable: "לא הצלחנו להגיע לספק",
  retries_spent: "כל הניסיונות לא הגיעו לספק",
  check_provider: "צריך לבדוק אצל הספק",
  job_dead: "העבודה ברקע נעצרה",
  job_refused: "העבודה ברקע לא התחילה",
  provider_changed: "הספק של העסק הוחלף",
  org_not_writable: "העסק לא יכול לרשום מסמכים כרגע",
  "feature:documents": "מסמכים לא כלולים בחבילה",
  requester_gone: "מי שביקש כבר לא חבר בעסק",
  issued_after_close: "הופק אחרי שהבקשה נסגרה",
  customer_erased: "פרטי הלקוח נמחקו",
  stale: "הבקשה המתינה יותר מיממה",
  not_at_provider: "לא נמצא אצל הספק",
};

export function isInvoiceProviderEventKind(kind: string): kind is InvoiceProviderEventKind {
  return (INVOICE_PROVIDER_EVENT_KINDS as readonly string[]).includes(kind);
}

/** = app.invoice_provider_auth_code: the provider refused the business's key (the connection itself, not one document). */
export function isConnectionAuthCode(code: string | null): boolean {
  return code !== null && /^((customer|product)_)?auth(:|$)/.test(code);
}

/** = app.invoice_provider_unreachable_code: the provider could not be reached. */
export function isUnreachableCode(code: string | null): boolean {
  return code !== null && /^((customer|product)_)?(unreachable|timeout)$/.test(code);
}

/**
 * The code the worker records for a provider's failure: an `auth` failure (the key was refused) is sent as `auth:<code>`, so
 * the database can tell a fallen connection from one refused document (DOC-16). The record keeps at most 64 characters.
 */
export function providerFailureCode(failure: { kind: "retry" | "refused" | "auth"; code: string }): string {
  return (failure.kind === "auth" ? `auth:${failure.code}` : failure.code).slice(0, 64);
}

function codeReason(code: string): string | null {
  if (Object.hasOwn(CODE_TEXT, code)) return CODE_TEXT[code];
  if (isConnectionAuthCode(code)) return "הספק לא קיבל את פרטי החיבור";
  if (isUnreachableCode(code)) return "לא הצלחנו להגיע לספק";
  if (code.startsWith("customer_")) return "עדכון הלקוח אצל הספק נכשל";
  if (code.startsWith("product_")) return "עדכון מוצר אצל הספק נכשל";
  return null;
}

/** The line for an entry: the kind's text, the reason when the code is known, and the count of a folded day line. */
export function invoiceProviderEventText(kind: string, code: string | null, hits: number): { text: string; tone: EventTone } {
  const base = isInvoiceProviderEventKind(kind) ? KIND_TEXT[kind] : { text: "אירוע בחיבור", tone: "neutral" as const };
  let reason: string | null = null;
  if (code !== null) {
    if (kind === "issued") {
      reason = Object.hasOwn(DOCUMENT_TYPE_LABELS, code) ? DOCUMENT_TYPE_LABELS[code as keyof typeof DOCUMENT_TYPE_LABELS] : null;
    } else {
      reason = codeReason(code);
    }
  }
  const tone: EventTone = isConnectionAuthCode(code) ? "danger" : base.tone;
  const counted = hits > 1 ? ` (${hits.toLocaleString("he-IL")})` : "";
  return { text: `${base.text}${reason ? `: ${reason}` : ""}${counted}`, tone };
}

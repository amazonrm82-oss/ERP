/**
 * INT-03: the Hebrew line for one sync log entry (public.integration_events). kind is a closed list (the table's check
 * constraint, `INTEGRATION_EVENT_KINDS`); code is a short server code. An unknown code falls back to the kind's own line.
 */

export const INTEGRATION_EVENT_KINDS = [
  "created",
  "connected",
  "disconnected",
  "token_saved",
  "verified",
  "token_invalid",
  "page_taken",
  "secret_unreadable",
  "error",
  "fetch_ok",
  "fetch_failed",
  "lead_refused",
  "lead_given_up",
  "test_ok",
  "test_failed",
] as const;
export type IntegrationEventKind = (typeof INTEGRATION_EVENT_KINDS)[number];

export type EventTone = "neutral" | "success" | "warning" | "danger";

const KIND_TEXT: Record<IntegrationEventKind, { text: string; tone: EventTone }> = {
  created: { text: "החיבור נוצר", tone: "neutral" },
  connected: { text: "החיבור הופעל מחדש", tone: "success" },
  disconnected: { text: "החיבור נותק", tone: "neutral" },
  token_saved: { text: "נשמר טוקן", tone: "success" },
  verified: { text: "החיבור אומת: הליד הראשון נקלט", tone: "success" },
  token_invalid: { text: "פייסבוק לא קיבלה את הטוקן", tone: "danger" },
  page_taken: { text: "הדף מחובר לעסק אחר במקסוז", tone: "danger" },
  secret_unreadable: { text: "לא הצלחנו לקרוא את הטוקן השמור", tone: "danger" },
  error: { text: "תקלה בחיבור", tone: "warning" },
  fetch_ok: { text: "לידים נקלטו", tone: "success" },
  fetch_failed: { text: "משיכת ליד נכשלה ותנוסה שוב", tone: "warning" },
  lead_refused: { text: "לידים לא נקלטו", tone: "warning" },
  lead_given_up: { text: "לידים לא נמשכו במשך שלושה ימים", tone: "danger" },
  test_ok: { text: "בדיקת חיבור: תקין", tone: "success" },
  test_failed: { text: "בדיקת חיבור נכשלה", tone: "warning" },
};

const CODE_TEXT: Record<string, string> = {
  graph_unavailable: "פייסבוק לא ענתה",
  token_invalid: "פייסבוק לא קיבלה את הטוקן",
  rate_limited: "יותר מדי פניות בבת אחת",
  intake_error: "תקלה בקליטה",
  invalid: "חסרים שם, טלפון ואימייל",
  form_off: "הטופס כבוי",
  feature_off: "לא כלול בחבילה",
  not_taken: "העסק לא מקבל לידים כרגע",
  not_found: "הליד לא נמצא בפייסבוק",
};

// a test's codes read differently: not_found there means the token is not this page's
const TEST_CODE_TEXT: Record<string, string> = {
  token_invalid: "פייסבוק לא קיבלה את הטוקן",
  not_found: "הטוקן לא של הדף הזה",
  graph_unavailable: "פייסבוק לא ענתה",
  rate_limited: "פייסבוק לא ענתה",
  secret_unreadable: "לא הצלחנו לקרוא את הטוקן השמור",
  page_taken: "הדף מחובר לעסק אחר במקסוז",
  changed: "הטוקן הוחלף בזמן הבדיקה",
  closed: "החיבור לא פעיל",
};

export function isIntegrationEventKind(kind: string): kind is IntegrationEventKind {
  return (INTEGRATION_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The line for an entry: the kind's text, the reason when the code is known, and the count for a folded day line. */
export function integrationEventText(kind: string, code: string | null, hits: number): { text: string; tone: EventTone } {
  const base = isIntegrationEventKind(kind) ? KIND_TEXT[kind] : { text: "אירוע בחיבור", tone: "neutral" as const };
  const codes = kind === "test_failed" ? TEST_CODE_TEXT : CODE_TEXT;
  const reason = code !== null && Object.hasOwn(codes, code) && codes[code] !== base.text ? codes[code] : null;
  const counted = hits > 1 ? ` (${hits.toLocaleString("he-IL")})` : "";
  return { text: `${base.text}${reason ? `: ${reason}` : ""}${counted}`, tone: base.tone };
}

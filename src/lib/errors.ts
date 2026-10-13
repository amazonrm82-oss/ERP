import { MENTION_MAX } from "@/features/mentions/token";
import { SUPPORT_LINE } from "@/lib/support-phone";

// Maps Postgres / PostgREST / Supabase Auth errors to short Hebrew messages.
// Raw database messages are never shown to the user.

type ErrorLike = {
  code?: string | null;
  message?: string | null;
  hint?: string | null;
  status?: number | null;
  name?: string | null;
};

export const GENERIC_ERROR = "משהו השתבש. נסו שוב בעוד רגע.";
export const NETWORK_ERROR = "אין חיבור לשרת כרגע. בדקו את החיבור לאינטרנט ונסו שוב.";
export const NO_PERMISSION = "אין לכם הרשאה לבצע את הפעולה הזו.";
export const NOT_FOUND = "הרשומה לא נמצאה. ייתכן שנמחקה או שאין לכם גישה אליה.";
export const SESSION_EXPIRED = "החיבור פג. יש להתחבר מחדש.";
// RVW-13: functions on a user's own data (notification settings, devices, the
// signed agreement, backup codes) refuse a session that has not passed the
// second step (app.session_verified(): 42501, hint mfa:aal2_required).
export const SECOND_STEP_HINT = "mfa:aal2_required";
export const SECOND_STEP_REQUIRED = "כדי לשנות את זה צריך קודם להשלים את האימות הדו-שלבי בכניסה הזו.";

/** True when the database refused because this session has not passed the second step. */
export function needsSecondStep(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as ErrorLike;
  return e.code === "42501" && (e.hint ?? "").trim() === SECOND_STEP_HINT;
}

// An UPDATE that RLS filters out succeeds with zero rows, so "nothing changed"
// means either "not found" or "not allowed"; the database does not say which.
export const NOT_FOUND_OR_FORBIDDEN = "לא ניתן לעדכן את הרשומה. ייתכן שנמחקה או שאין לכם הרשאה לערוך אותה.";

const LIMIT_MESSAGES: Record<string, string> = {
  "limit:max_records": "הגעתם למספר הרשומות המרבי בחבילה. אפשר לפנות מקום, או לבקש מבעלי העסק חבילה גדולה יותר. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_users": "הגעתם למספר המשתמשים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:seats": "כל המושבים שנרכשו תפוסים. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_pipelines": "הגעתם למספר תהליכי המכירה המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_custom_fields_per_object": "הגעתם למספר השדות המותאמים המרבי בחבילה.",
  "limit:owned_organizations": "אפשר להיות הבעלים של עד 5 עסקים.",
  "limit:max_forms": "הגעתם למספר הטפסים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:api": "חיבור webhook אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_active_automations": "הגעתם למספר האוטומציות הפעילות המרבי בחבילה. אפשר לכבות אוטומציה אחרת. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:view_seats": "מושבי צפייה אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:storage_gb": "נגמר נפח האחסון בחבילה. אפשר למחוק קבצים ישנים. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  // not limits, but raised the same way (migrations 0026, 0027)
  "erase:exists": "הרשומה עדיין קיימת. קודם מעבירים אותה לסל המחזור ומוחקים משם לצמיתות.",
  "custom_field:invalid": "אחד השדות המותאמים אינו תקין, או שהוסר בינתיים. רעננו את הדף ונסו שוב.",
  // LEAD-03 (migration disqualify_reasons)
  "lead:disqualify_reason": "יש לבחור סיבה מהרשימה. אם הרשימה השתנתה, רעננו את הדף.",
  "reasons:max": "אפשר לשמור עד 50 סיבות. מחקו סיבה שלא בשימוש כדי להוסיף חדשה.",
  // CON-04 (migration israeli_ids)
  "tax_id:invalid": "מספר ח.פ. או עוסק מורשה אינו תקין. בדקו את 9 הספרות.",
  // CON-04, a company outside Israel (migration foreign_company_number)
  "tax_id:invalid_foreign": "מספר הרישום אינו תקין. אפשר 2 עד 30 תווים: אותיות באנגלית, ספרות, רווח, מקף, נקודה ולוכסן.",
  // CON-02 (migration record_types)
  "record_type:invalid": "יש לבחור סוג מהרשימה. אם הרשימה השתנתה, רעננו את הדף.",
  "record_types:max": "אפשר לשמור עד 50 סוגים. מחקו סוג שלא בשימוש כדי להוסיף חדש.",
  // USR-01 (migration profile_fields, trigger profiles_check)
  "profile:full_name": "השם ארוך מדי. אפשר עד 120 תווים.",
  "profile:phone": "מספר הטלפון אינו תקין.",
  "profile:locale": "השפה שנבחרה אינה נתמכת.",
  "profile:timezone": "אזור הזמן הזה אינו נתמך. בחרו עיר אחרת באותו אזור זמן.",
  "profile:avatar": "התמונה לא נשמרה. העלו אותה שוב.",
  "branding:logo": "הלוגו לא נשמר. העלו אותו שוב.",
  // FLD-05 (apply_industry_template)
  "template:unknown": "התבנית הזו לא קיימת. רעננו את הדף ובחרו תבנית מהרשימה.",
  // REC-02 (trigger activities_notify_mentions)
  "mention:forbidden": "אפשר לאזכר רק מי שרשאי לראות את הרשומה. הסירו את האזכור ונסו שוב.",
  "mention:too_many": `אפשר לאזכר עד ${MENTION_MAX} אנשים בהערה אחת.`,
};

// P0001 raised without a hint: recognised by the (stable) English message.
const RAISED_MESSAGES: Array<[RegExp, string]> = [
  [/already converted/i, "הליד כבר הומר."],
  [/no open stage/i, "אין בתהליך המכירה שלב פתוח לשים בו את העסקה. יש להוסיף שלב בהגדרות."],
];

// Exceptions our own functions and triggers raise with other codes, recognised
// by their (stable) English message. Checked before the generic code mapping.
const OWN_MESSAGES: Array<[RegExp, string]> = [
  [/only the owner can (change|remove) another admin/i, "רק הבעלים יכול לשנות או להסיר מנהל מערכת אחר."],
  [/only the owner can (make someone|invite) an admin/i, "רק הבעלים יכול למנות מנהל מערכת."],
  [/cannot change your own role/i, "אי אפשר לשנות את התפקיד או את הסטטוס של עצמך."],
  [/owner cannot be (removed|suspended)|ownership changes only/i, "אי אפשר לשנות את הבעלים. אפשר להעביר בעלות."],
  [/already a member/i, "המשתמש כבר חבר בעסק."],
  [/invitation is invalid or has expired/i, "ההזמנה אינה בתוקף. בקשו ממי שהזמין אתכם לשלוח הזמנה חדשה."],
  [/invitation was sent to a different email/i, "ההזמנה נשלחה לכתובת אימייל אחרת. התחברו עם החשבון של הכתובת שאליה נשלחה ההזמנה."],
  [/new owner must be an active member/i, "הבעלים החדש צריך להיות משתמש פעיל עם מושב מלא."],
  [/invalid email address/i, "כתובת האימייל אינה תקינה."],
  // REC-05: trigger activities_edit_window (hint note:edit_window)
  [/note edit window closed/i, "אפשר לערוך הערה רק ב-24 השעות הראשונות. אחרי זה רק מנהל מערכת יכול לערוך אותה."],
  // REC-01: trigger activities_edit_window (hint note:pin_only), a team manager on a colleague's entry
  [/note pin only/i, "אפשר לנעוץ את הרשומה הזו, אבל רק מי שכתב אותה או מנהל מערכת יכולים לערוך אותה."],
  // RVW-1: trigger activities_verify_meeting_entry (hint meeting:entry); the app never sends the key
  [/meeting entry link is set by the server/i, "את הקישור לפגישה המערכת קובעת. אי אפשר לשנות אותו."],
  // CAL-01: trigger meetings_check_links
  [/meeting linked to a record the user cannot see/i, "אי אפשר לקשר את הפגישה לרשומה שאין לכם גישה אליה."],
  [/meeting organizer must be an active member/i, "מארגן הפגישה צריך להיות משתמש פעיל בעסק."],
  [/not allowed to change the meeting organizer/i, "רק מי שמארגן את הפגישה, מי שקבע אותה, בעלי העסק ומנהלי המערכת יכולים לקבוע מי מארגן אותה."],
];

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "האימייל או הסיסמה שגויים.",
  email_not_confirmed: "כתובת האימייל עוד לא אומתה. חפשו את הודעת האימות בתיבת הדואר.",
  user_already_exists: "כבר קיים חשבון עם כתובת האימייל הזו. אפשר להתחבר.",
  email_exists: "כבר קיים חשבון עם כתובת האימייל הזו. אפשר להתחבר.",
  weak_password: "הסיסמה חלשה מדי, או שהיא הופיעה בדליפת מידע מוכרת. בחרו סיסמה אחרת, ארוכה יותר.",
  same_password: "הסיסמה החדשה זהה לקודמת.",
  email_address_invalid: "כתובת האימייל אינה תקינה.",
  signup_disabled: "ההרשמה סגורה כרגע.",
  user_banned: `החשבון חסום. לבירור: ${SUPPORT_LINE}.`,
  over_request_rate_limit: "יותר מדי ניסיונות. המתינו דקה ונסו שוב.",
  over_email_send_rate_limit: "נשלחו יותר מדי הודעות אימייל. המתינו כמה דקות ונסו שוב.",
  session_not_found: SESSION_EXPIRED,
  session_expired: SESSION_EXPIRED,
  refresh_token_not_found: SESSION_EXPIRED,
  flow_state_not_found: "קישור האימות אינו תקף עוד. בקשו קישור חדש.",
  flow_state_expired: "קישור האימות פג. בקשו קישור חדש.",
  otp_expired: "קישור האימות פג. בקשו קישור חדש.",
  insufficient_aal: "כדי לשנות את זה צריך קודם להזין את קוד האימות הדו-שלבי. התנתקו, התחברו שוב והזינו את הקוד.",
  reauthentication_needed: "מטעמי אבטחה צריך להתחבר מחדש לפני שינוי הסיסמה.",
  mfa_verification_failed: "הקוד לא התאים. נסו את הקוד הבא באפליקציה.",
  bad_code_verifier: "קישור האימות נפתח בדפדפן אחר מזה שבו נרשמתם. פתחו אותו באותו דפדפן.",
};

function asErrorLike(error: unknown): ErrorLike | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  return error as ErrorLike;
}

function looksLikeNetworkFailure(error: ErrorLike): boolean {
  const text = `${error.name ?? ""} ${error.message ?? ""}`;
  return (
    error.name === "AuthRetryableFetchError" ||
    /fetch failed|failed to fetch|networkerror|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(text)
  );
}

/** Hebrew message for an error returned by a table query or an RPC call. */
export function dbErrorMessage(error: unknown, fallback: string = GENERIC_ERROR): string {
  const e = asErrorLike(error);
  if (!e) {
    return fallback;
  }
  const code = e.code ?? "";

  if (code === "P0001") {
    const hint = (e.hint ?? "").trim();
    if (hint in LIMIT_MESSAGES) {
      return LIMIT_MESSAGES[hint];
    }
    if (hint.startsWith("limit:")) {
      return "הגעתם למגבלת החבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.";
    }
    if (hint.startsWith("feature:")) {
      return "היכולת הזו אינה כלולה בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.";
    }
    const message = e.message ?? "";
    for (const [pattern, text] of RAISED_MESSAGES) {
      if (pattern.test(message)) {
        return text;
      }
    }
    return fallback;
  }

  if (needsSecondStep(e)) {
    return SECOND_STEP_REQUIRED;
  }

  const ownMessage = OWN_MESSAGES.find(([pattern]) => pattern.test(e.message ?? ""));
  if (ownMessage) {
    return ownMessage[1];
  }

  switch (code) {
    case "42501":
      return NO_PERMISSION;
    case "P0002":
    case "PGRST116":
      return NOT_FOUND;
    case "23505":
      return "כבר קיימת רשומה כזו.";
    case "23503":
      return "אחד הערכים שנבחרו כבר לא קיים. רעננו את הדף ונסו שוב.";
    case "23514":
    case "23502":
    case "22023":
    case "22P02":
      return "חלק מהפרטים חסרים או לא תקינים. בדקו את הטופס ונסו שוב.";
    case "28000":
    case "PGRST301":
    case "PGRST302":
      return SESSION_EXPIRED;
    default:
      break;
  }

  if (looksLikeNetworkFailure(e)) {
    return NETWORK_ERROR;
  }
  return fallback;
}

/** Hebrew message for an error returned by supabase.auth.* */
export function authErrorMessage(error: unknown, fallback: string = GENERIC_ERROR): string {
  const e = asErrorLike(error);
  if (!e) {
    return fallback;
  }
  const code = e.code ?? "";
  if (code in AUTH_MESSAGES) {
    return AUTH_MESSAGES[code];
  }
  if (looksLikeNetworkFailure(e)) {
    return NETWORK_ERROR;
  }
  if (e.status === 429) {
    return AUTH_MESSAGES.over_request_rate_limit;
  }
  return fallback;
}

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
export const NO_PERMISSION = "אין לך הרשאה לבצע את הפעולה הזו.";
export const NOT_FOUND = "הרשומה לא נמצאה. ייתכן שנמחקה או שאין לך גישה אליה.";
export const SESSION_EXPIRED = "החיבור פג. יש להתחבר מחדש.";
// An UPDATE that RLS filters out succeeds with zero rows, so "nothing changed"
// means either "not found" or "not allowed"; the database does not say which.
export const NOT_FOUND_OR_FORBIDDEN = "לא ניתן לעדכן את הרשומה. ייתכן שנמחקה או שאין לך הרשאה לערוך אותה.";

const LIMIT_MESSAGES: Record<string, string> = {
  "limit:max_records": "הגעתם למספר הרשומות המרבי בחבילה. כדי להוסיף רשומות יש לשדרג חבילה או לפנות מקום.",
  "limit:max_users": "הגעתם למספר המשתמשים המרבי בחבילה. כדי להוסיף משתמשים יש לשדרג חבילה.",
  "limit:seats": "כל המושבים שנרכשו תפוסים. יש להוסיף מושבים כדי לצרף משתמש.",
  "limit:max_pipelines": "הגעתם למספר הפייפליינים המרבי בחבילה. כדי להוסיף פייפליין יש לשדרג חבילה.",
  "limit:max_custom_fields_per_object": "הגעתם למספר השדות המותאמים המרבי בחבילה.",
  "limit:owned_organizations": "אפשר להיות הבעלים של עד 5 עסקים.",
  "feature:view_seats": "מושבי צפייה אינם כלולים בחבילה הנוכחית. יש לשדרג חבילה.",
};

// P0001 raised without a hint: recognised by the (stable) English message.
const RAISED_MESSAGES: Array<[RegExp, string]> = [
  [/already converted/i, "הליד כבר הומר."],
  [/no open stage/i, "אין בפייפליין שלב פתוח לשים בו את העסקה. יש להוסיף שלב בהגדרות."],
];

const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "האימייל או הסיסמה שגויים.",
  email_not_confirmed: "כתובת האימייל עוד לא אומתה. חפשו את הודעת האימות בתיבת הדואר.",
  user_already_exists: "כבר קיים חשבון עם כתובת האימייל הזו. אפשר להתחבר.",
  email_exists: "כבר קיים חשבון עם כתובת האימייל הזו. אפשר להתחבר.",
  weak_password: "הסיסמה חלשה מדי. בחרו סיסמה ארוכה יותר עם אותיות ומספרים.",
  same_password: "הסיסמה החדשה זהה לקודמת.",
  email_address_invalid: "כתובת האימייל אינה תקינה.",
  signup_disabled: "ההרשמה סגורה כרגע.",
  user_banned: "החשבון חסום. פנו לתמיכה.",
  over_request_rate_limit: "יותר מדי ניסיונות. המתינו דקה ונסו שוב.",
  over_email_send_rate_limit: "נשלחו יותר מדי הודעות אימייל. המתינו כמה דקות ונסו שוב.",
  session_not_found: SESSION_EXPIRED,
  session_expired: SESSION_EXPIRED,
  refresh_token_not_found: SESSION_EXPIRED,
  flow_state_not_found: "קישור האימות אינו תקף עוד. בקשו קישור חדש.",
  flow_state_expired: "קישור האימות פג. בקשו קישור חדש.",
  otp_expired: "קישור האימות פג. בקשו קישור חדש.",
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
      return "הגעתם למגבלת החבילה. כדי להמשיך יש לשדרג חבילה.";
    }
    if (hint.startsWith("feature:")) {
      return "היכולת הזו אינה כלולה בחבילה הנוכחית. יש לשדרג חבילה.";
    }
    const message = e.message ?? "";
    for (const [pattern, text] of RAISED_MESSAGES) {
      if (pattern.test(message)) {
        return text;
      }
    }
    return fallback;
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

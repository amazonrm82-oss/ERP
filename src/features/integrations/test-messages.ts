export type ConnectionTestOutcome =
  | "ok"
  | "page_taken"
  | "token_invalid"
  | "not_found"
  | "graph_unavailable"
  | "rate_limited"
  | "secret_unreadable"
  | "changed"
  | "closed"
  | "expired"
  | "busy"
  | "error"
  | "no_provider"
  | "no_key"
  | "refused_not_found"
  | "refused_read_only"
  | "refused_feature"
  | "refused_closed"
  | "refused_no_secret"
  | "refused_rate";

/** INT-01: the Hebrew line for a "test connection" outcome (pure; unit-tested). */
export function connectionTestMessage(outcome: ConnectionTestOutcome, retrySeconds?: number): { ok: boolean; text: string } {
  switch (outcome) {
    case "ok":
      return { ok: true, text: "החיבור תקין: פייסבוק קיבלה את הטוקן השמור, והוא של הדף הזה." };
    case "page_taken":
      return { ok: false, text: "הדף הזה כבר מחובר לעסק אחר במקסוז, ולכן החיבור כאן הופסק." };
    case "token_invalid":
      return { ok: false, text: "פייסבוק לא מקבלת את הטוקן השמור. שמרו טוקן חדש של הדף." };
    case "not_found":
      return { ok: false, text: "פייסבוק קיבלה את הטוקן, אבל הוא לא של הדף הזה. שמרו את הטוקן של הדף הנכון." };
    case "secret_unreadable":
      return { ok: false, text: "לא הצלחנו לקרוא את הטוקן השמור. שמרו טוקן חדש של הדף." };
    case "graph_unavailable":
    case "rate_limited":
      return { ok: false, text: "פייסבוק לא ענתה כרגע. נסו שוב בעוד כמה דקות." };
    case "busy":
      return { ok: false, text: "החיבור עסוק כרגע. נסו שוב בעוד רגע." };
    case "changed":
      return { ok: false, text: "הטוקן הוחלף בזמן הבדיקה. נסו לבדוק שוב." };
    case "closed":
    case "refused_closed":
      return { ok: false, text: "החיבור הזה לא פעיל, ולכן אי אפשר לבדוק אותו. חברו אותו מחדש או שמרו טוקן חדש." };
    case "refused_no_secret":
      return { ok: false, text: "עוד לא נשמר טוקן לחיבור הזה." };
    case "refused_read_only":
      return { ok: false, text: "העסק במצב קריאה בלבד, ולכן אי אפשר לבדוק את החיבור." };
    case "refused_feature":
      return { ok: false, text: "קבלת לידים מפייסבוק ומאינסטגרם אינה כלולה בחבילה הנוכחית." };
    case "refused_rate": {
      const minutes = Math.max(1, Math.ceil((retrySeconds ?? 600) / 60));
      return { ok: false, text: `אפשר לבדוק את החיבור עד 5 פעמים ב-10 דקות. נסו שוב בעוד ${minutes} דקות.` };
    }
    case "no_provider":
      return { ok: false, text: "החיבור לפייסבוק ולאינסטגרם עוד לא הופעל במערכת, ולכן אי אפשר לבדוק אותו כרגע." };
    case "no_key":
      return { ok: false, text: "מפתח ההצפנה של המערכת עוד לא הוגדר, ולכן אי אפשר לקרוא את הטוקן. פנו לתמיכה." };
    case "expired":
    case "refused_not_found":
    case "error":
    default:
      return { ok: false, text: "לא הצלחנו לבדוק את החיבור. נסו שוב." };
  }
}

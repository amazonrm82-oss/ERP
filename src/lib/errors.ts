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
  // PostgREST calls Postgres' DETAIL "details"; node-postgres calls it "detail"
  details?: string | null;
  detail?: string | null;
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

// TAX-03: no VAT rate is known for a document's date (before the first row of public.vat_rates)
export const VAT_BEFORE_TABLE = 'תאריך המסמך מוקדם מכל שיעורי המע"מ שבמערכת, ולכן אי אפשר לחשב לו מע"מ. בחרו תאריך מאוחר יותר.';

// ADM-01: a VAT rate is set only from a day after today; one whose day has begun is locked
export const VAT_RATE_FUTURE_ONLY = 'אפשר לקבוע שיעור מע"מ רק מיום שאחרי היום. שיעור שכבר התחיל נעול.';

// ADM-01: a subprocessor already in force is locked; it is ended from a future day
export const SUBPROCESSOR_IN_FORCE = "קבלן משנה שכבר בתוקף נעול. אפשר רק לקבוע לו תאריך סיום עתידי, או להשלים מיקום ואתר שחסרים.";
// ADM-01: the DPA promises customers 14 days of notice
export const SUBPROCESSOR_NOTICE = "קבלן משנה חדש נכנס לתוקף לפחות 14 יום אחרי היום, כדי שהלקוחות יקבלו הודעה מראש.";

const LIMIT_MESSAGES: Record<string, string> = {
  // FXS-09: sign_agreement() accepts only the registered texts of a version; for the app this happens only while a
  // deploy and its migration are out of step, so the message asks to try again soon
  "agreement:changed": `לא ניתן לחתום כרגע על ההסכם. נסו שוב בעוד כמה דקות, ואם זה חוזר פנו לתמיכה: ${SUPPORT_LINE}.`,
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
  // REC-07 (trigger files_links_check)
  "file:note": "אפשר לצרף קובץ רק להערה שכתבתם, באותה רשומה.",
  "file:version": "גרסה חדשה שייכת לאותה רשומה ולאותה הערה כמו הקובץ הקודם.",
  "file:version_taken": "מישהו כבר העלה גרסה חדשה של הקובץ הזה. רעננו את הדף והעלו מעל הגרסה האחרונה.",
  "file:pending_max": "יותר מדי קבצים עדיין בהעלאה. חכו כמה דקות ונסו שוב.",
  "file:document_type": "למסמך או לתשלום אפשר לצרף רק PDF או תמונה.",
  // FLD-06 part B (migration field_types_part_b)
  "file:field": "הקובץ שייך לשדה מסוג קובץ: מחליפים או מסירים אותו מהשדה עצמו, ברשומה שמותר לכם לערוך.",
  "custom_field:type_locked": "אי אפשר לשנות את הסוג של שדה קישור לרשומה או שדה קובץ, ולא את סוג הרשומה שהקישור מצביע עליה. אפשר להוסיף שדה חדש.",
  "custom_field:automation": "אוטומציה לא מעדכנת שדה של קישור לרשומה או של קובץ.",
  "file:kept": "קובץ של מסמך או של תשלום לא נמחק. אפשר להעלות גרסה חדשה (הקודמת נשמרת), או לבטל את המסמך או התשלום עם סיבה.",
  // wave 2 plan keys (migration wave2_plan_keys; src/lib/plan-keys.ts)
  "feature:products": "קטלוג המוצרים אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:price_lists": "מחירונים אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:discounts": "הנחות אינן כלולות בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:quotes": "הצעות מחיר אינן כלולות בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  // DOC-01: recording external documents
  "document:duplicate": "מסמך מהסוג הזה עם המספר הזה כבר רשום בעסק. בדקו את המספר.",
  "document:parent": "מסמך נרשם על עסקה או על איש קשר.",
  "document:frozen": "מסמך שנרשם לא משתנה. אם נרשם בטעות, בטלו אותו עם סיבה ורשמו אותו מחדש.",
  "document:cancelled": "רישום שבוטל נשאר מבוטל.",
  "document:cancel_reason": "יש לכתוב למה הרישום מבוטל (עד 500 תווים).",
  // GAP-12: the opening balance of an imported customer
  "document:opening_admin": "יתרת פתיחה רושמים, משנים ומבטלים רק בעלים ומנהלי מערכת.",
  "document:opening_exists": "ללקוח כבר יש יתרת פתיחה בתוקף. כדי לשנות אותה, רשמו יתרה חדשה במקומה.",
  "document:opening_job": "יתרת פתיחה מייבוא נרשמת רק בייבוא אנשי קשר או חברות שאתם מריצים עכשיו.",
  "document:opening_amount": "יתרת פתיחה היא חוב (סכום חיובי) או זכות (סכום שלילי), עם תאריך.",
  "document:opening_balance": "יתרת פתיחה לא שייכת להזמנה או לעסקה. רשמו אותה בכרטיס של איש הקשר או החברה.",
  "feature:orders": "מודול ההזמנות אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:documents": "רישום מסמכים אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  // PAY-01, PAY-06: recording payments
  "payment:parent": "תשלום נרשם על עסקה או על איש קשר.",
  "payment:status": "תשלום חדש נרשם במצב \"נרשם\" או \"אושר\".",
  "payment:frozen": "תשלום נשאר על העסקה ואיש הקשר שעליהם נרשם. אם נרשם על הלקוח הלא נכון, בטלו אותו עם סיבה ורשמו אותו מחדש.",
  "payment:correction": "תיקון של תשלום, ביטול שלו וסימון שהוחזר, רק לבעלים ולמנהלי מערכת.",
  "payment:cancelled": "תשלום שבוטל נשאר מבוטל, ואי אפשר לשנות בו דבר.",
  "payment:cancel_reason": "יש לכתוב למה התשלום מבוטל (עד 500 תווים).",
  "payment:allocated": "לתשלום הזה כבר משויך סכום גדול יותר. בטלו קודם שיוכים, ואז תקנו את הסכום.",
  "ledger:period": "יש לבחור תקופה: תאריך התחלה ותאריך סיום, וההתחלה לפני הסיום.",
  "allocation:doc_type": "רק חשבונית מס, חשבון עסקה או יתרת פתיחה של חוב מקבלים שיוך של תשלום.",
  "allocation:payment_state": "רק תשלום במצב \"נרשם\" או \"אושר\" משויך למסמך.",
  "allocation:document_state": "מסמך שבוטל לא מקבל שיוך של תשלום.",
  "allocation:transferred": "חשבון העסקה הזה הוחלף בחשבונית מס. שייכו את התשלום לחשבונית.",
  "allocation:customer": "תשלום משויך רק למסמך של אותו לקוח: אותה עסקה, אותו איש קשר או אותה חברה.",
  "allocation:payment_over": "הסכום גבוה ממה שנשאר בתשלום לשיוך.",
  "allocation:document_over": "הסכום גבוה מהיתרה של המסמך.",
  "allocation:fixed": "שיוך נשאר על התשלום והמסמך שלו. בטלו אותו ושייכו מחדש.",
  "allocation:closed": "שיוך שבוטל או שוחרר כבר לא משתנה.",
  "allocation:admin": "שינוי סכום של שיוך וביטול שלו, רק לבעלים ולמנהלי מערכת.",
  // GAP-12: offsetting an opening credit
  "credit_allocation:credit": "רק יתרת פתיחה של זכות (סכום שלילי) שבתוקף מקוזזת מול מסמך.",
  "credit_allocation:over": "הסכום גבוה ממה שנשאר ביתרת הזכות לקיזוז.",
  "credit:max": "סכום הקיזוז מיתרת הזכות צריך להיות גדול מאפס.",
  "payment:advance_link": "מקדמה מקושרת רק להצעה שנשלחה או להזמנה ממוספרת של אותו לקוח, שלא בוטלו.",
  "document:due_date": "מועד תשלום נקבע רק בחשבונית מס, בחשבון עסקה או ביתרת פתיחה של חוב, פעילים, ולא לפני תאריך המסמך.",
  "document:proforma": "חשבונית מס פעילה מחליפה חשבון עסקה פעיל אחד של אותו לקוח, פעם אחת, וחשבון עסקה מוחלף בחשבונית אחת בלבד.",
  // GAP-08: the quick sale
  "quick_sale:invalid": "פרטי המכירה חסרים או לא תקינים. בדקו את הלקוח, הפריטים והתשלום.",
  "quick_sale:cannot": "אין לכם הרשאה למכירה מהירה כאן.",
  "quick_sale:contact": "הלקוח שנבחר לא נמצא, או שהוא בסל המחזור. בחרו לקוח אחר.",
  "quick_sale:no_pipeline": "אין בעסק תהליך מכירה. הוסיפו תהליך מכירה בהגדרות.",
  "quick_sale:no_won_stage": "בתהליך המכירה הראשי אין שלב \"נסגר בהצלחה\". הוסיפו שלב כזה בהגדרות.",
  "quick_sale:product": "אחד הפריטים כבר לא פעיל בקטלוג. הסירו אותו ובחרו שוב.",
  "quick_sale:recurring": "מכירה מהירה היא חיוב אחד. מוצר בחיוב חוזר נמכר דרך עסקה.",
  "quick_sale:vat_unknown": "עוד לא נקבע המעמד של העסק במע\"מ. בעלי העסק קובעים אותו ב\"הגדרות > מע\"מ ופרטים למסמכים\".",
  "quick_sale:zero": "סכום המכירה צריך להיות גדול מאפס.",
  "quick_sale:price": "המחיר של אחד הפריטים השתנה (מחיר המוצר או המחירון של הלקוח). בדקו את הסכום החדש ונסו שוב.",
  "quick_sale:cheques_total": "סכומי הצ'קים צריכים להסתכם בדיוק בסכום לתשלום.",
  "quick_sale:total_changed": "המחיר השתנה בזמן שמילאתם את המכירה. בדקו את הסכום החדש ונסו שוב.",
  "cheque:fields": "בצ'ק יש למלא מספר, בנק, סניף (או שם הבנק אם הוא בחו\"ל), תאריך פירעון ומצב.",
  "cheque:bank": "יש לבחור בנק מהרשימה, או \"אחר\" לבנק בחו\"ל.",
  "cheque:branch": "מספר הסניף הוא 3 ספרות.",
  "cheque:status": "מצב של תשלום בצ'ק נקבע לפי מצב הצ'ק. שנו את מצב הצ'ק.",
  "cheque:bounced": "החזרת צ'ק ממצב \"חזר\" רק לבעלים ולמנהלי מערכת.",
  "cheque:reason": "יש לכתוב למה הצ'ק חוזר ממצב \"חזר\" (עד 500 תווים).",
  "cheque:refunded": "צ'ק של תשלום שהוחזר נשאר כפי שהוא.",
  "feature:payments": "רישום תשלומים אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:balances": "כרטסת הלקוח אינה כלולה בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  // COL-05
  "customer_hold:exists": "הלקוח כבר מסומן \"לא למכור עד הסדרת חוב\".",
  "customer_hold:frozen": "סימון שנשמר לא משתנה. אפשר להסיר אותו ולסמן מחדש עם סיבה אחרת.",
  "customer_hold:lifted": "סימון שהוסר נשאר מוסר. אפשר לסמן מחדש.",
  "feature:collection": "מסך הגבייה אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:money_waiting": "המסך \"כסף שמחכה\" אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:consents": "ניהול הסכמות לדיוור אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:segments": "סגמנטים אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:goals": "יעדים ותחזית אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:granular_permissions": "הרשאות נקודתיות אינן כלולות בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:booking_page": "דף קביעת תור אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:business_card": "כרטיס ביקור דיגיטלי אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:qr_codes": "קודי QR אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:site_widget": "הכפתור הצף לאתר אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:retention": "מדיניות שמירת מידע אינה כלולה בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_products": "הגעתם למספר המוצרים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_price_lists": "הגעתם למספר המחירונים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_quote_templates": "הגעתם למספר תבניות ההצעה המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_booking_pages": "הגעתם למספר דפי קביעת התור המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_segments": "הגעתם למספר הסגמנטים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_qr_codes": "הגעתם למספר קודי ה-QR המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  // per use; counted by the PDF module (QUO-06)
  "limit:max_pdf_per_month": `הגעתם למכסת קובצי ה-PDF החודשית. הקישור להצעה, הצפייה והחתימה ממשיכים לעבוד. לפרטים פנו לתמיכה: ${SUPPORT_LINE}.`,
  "rate:pdf": "הופקו הרבה קובצי PDF בדקה האחרונה. נסו שוב בעוד דקה.",
  // per use; emails a business sends to its own customers (wave 3 provider layer)
  "limit:max_customer_emails_per_month": `הגעתם למכסת האימיילים ללקוחות לחודש. אפשר לשלוח את ההודעה כקישור (WhatsApp או העתקה). לפרטים פנו לתמיכה: ${SUPPORT_LINE}.`,
  "limit:max_customer_emails_per_day": `הגעתם למכסת האימיילים ללקוחות להיום. אפשר לשלוח את ההודעה כקישור (WhatsApp או העתקה). לפרטים פנו לתמיכה: ${SUPPORT_LINE}.`,
  // owner's pricing of 13 October 2026 (migration plan_pricing)
  "feature:payment_links": "קישורי תשלום אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:instant_reply": "מענה מיידי ללקוח אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:auto_reassign": "העברה אוטומטית של ליד לנציג הבא אינה כלולה בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:lead_distribution": "חלוקת לידים לפי משקל, לפי עומס ולפי כללים אינה כלולה בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:dashboards": "דשבורדים אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:goals_per_rep": "יעד לכל נציג ולכל צוות אינו כלול בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "feature:booking_team_pages": "דפי קביעת תור לצוות אינם כלולים בחבילה הנוכחית. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_booking_pages_per_user": "הגעתם למספר דפי קביעת התור המרבי למשתמש בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_custom_reports": "הגעתם למספר הדוחות המותאמים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_custom_objects": "הגעתם למספר האובייקטים המותאמים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_teams": "הגעתם למספר הצוותים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_whatsapp_numbers": "הגעתם למספר מספרי ה-WhatsApp המחוברים המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:view_seats_per_paid_seat": "הגעתם למספר מושבי הצפייה שהחבילה מאפשרת לפי מספר המושבים בתשלום. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_site_widgets": "הגעתם למספר הכפתורים הצפים לאתר המרבי בחבילה. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:max_business_cards_per_user": "לכל משתמש יש כרטיס ביקור אחד.",
  "limit:max_booking_team_pages": `הגעתם למספר דפי קביעת התור הצוותיים בחבילה. לפרטים פנו לתמיכה: ${SUPPORT_LINE}.`,
  "limit:ai_credits_per_month": "נגמרו קרדיטי ה-AI של החודש. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  "limit:ai_credits_per_user_per_month": "נגמרו קרדיטי ה-AI של החודש. בעלי העסק רואים את השימוש ב\"הגדרות > חבילה ושימוש\", ושם גם איך מגדילים את החבילה.",
  // hidden plans cannot be chosen (migration hide_free_plan)
  "plan:hidden": "החבילה הזו לא זמינה יותר לבחירה.",
  "plan:not_available": "החבילה הזו תיפתח בקרוב. עדיין אי אפשר לבחור בה.",
  // not limits, but raised the same way (migrations 0026, 0027)
  "erase:exists": "הרשומה עדיין קיימת. קודם מעבירים אותה לסל המחזור ומוחקים משם לצמיתות.",
  // PRM-01 (migration member_permissions)
  "permissions:role": "הרשאות נוספות ניתנות רק למנהלי צוות ולעובדים פעילים. בעלים ומנהלי מערכת מחזיקים בכולן ממילא.",
  "permissions:invalid": "אחת ההרשאות אינה מוכרת. רעננו את הדף ונסו שוב.",
  "permissions:not_built": "אחת ההרשאות עוד לא זמינה. רעננו את הדף ונסו שוב.",
  "import_undo:status": "הייבוא עדיין רץ או שכבר בוטל.",
  "import_undo:type": "את הייבוא הזה אי אפשר לבטל כאן.",
  "import_undo:expired": "אפשר לבטל ייבוא רק בשבעת הימים הראשונים.",
  // FXD-07 (public.undo_import): nothing is undone while a record of the import is no longer the user's to change
  "import_undo:subtasks": "יש משימות מיובאות שנוספו להן תתי-משימות, ולכן אי אפשר לבטל את הייבוא.",
  "import_undo:left": "חלק מהרשומות שנוצרו בייבוא כבר אינן שלכם לשנות, ולכן הייבוא לא בוטל ושום רשומה לא הועברה לסל המחזור.",
  // FLD-08 (migration card_layouts)
  "card_layout:invalid": "התצוגה אינה תקינה, או שאחד השדות הוסר בינתיים. רעננו את הדף ונסו שוב.",
  // AUT-05: the conditions of an automation have a shape the engine does not know
  "automation:conditions": "התנאים של האוטומציה אינם תקינים. רעננו את הדף ונסו שוב.",
  "custom_field:invalid": "אחד השדות המותאמים אינו תקין, או שהוסר בינתיים. רעננו את הדף ונסו שוב.",
  // LEAD-03 (migration disqualify_reasons)
  "lead:disqualify_reason": "יש לבחור סיבה מהרשימה. אם הרשימה השתנתה, רעננו את הדף.",
  "reasons:max": "אפשר לשמור עד 50 סיבות. מחקו סיבה שלא בשימוש כדי להוסיף חדשה.",
  // LEAD-05 (migration lead_score)
  "lead_score_rules:max": "אפשר לשמור עד 50 כללי ניקוד. מחקו כלל שלא צריך כדי להוסיף חדש.",
  "lead_score_rule:invalid": "הכלל אינו תקין, או שהשדה או הערך שבחרתם הוסרו בינתיים. רעננו את הדף ונסו שוב.",
  // CAP-09 (migration working_hours_leave)
  "member_hours:other_orgs": "המשתמש שייך גם לעסק אחר, ולכן רק הוא יכול לשנות את שעות העבודה שלו, מהחשבון שלו.",
  "member_hours:invalid": "שעות העבודה אינן תקינות. בדקו שכל טווח מתחיל לפני שהוא נגמר ושהטווחים לא חופפים.",
  "member_leaves:max": "אפשר לשמור עד 100 חופשות נוכחיות ועתידיות לכל משתמש. חופשות שכבר עברו לא נספרות.",
  // LEAD-08: a leads import while the business has the leads module switched off
  "module:leads_off": "מודול הלידים כבוי בעסק, ולכן אי אפשר לייבא לידים. אפשר לייבא אנשי קשר, או להפעיל את המודול ב\"הגדרות > מודולים\".",
  "import:status": "ייבוא שהסתיים, נכשל או בוטל לא ממשיך לרוץ. אפשר לייבא שוב.",
  "lead_routing_rules:max": "אפשר לשמור עד 50 כללי חלוקה. מחקו כלל שלא בשימוש כדי להוסיף חדש.",
  "lead_routing_rules:field": "השדה צריך להיות שדה רשימה פעיל של לידים, והערך אחד מהערכים שלו.",
  "lead_routing_rules:user_inactive": "אפשר להפנות רק לעובד פעיל בעסק שאינו צופה.",
  // HEB-08: who may stand in during an absence
  "member_leaves:deputy_self": "אי אפשר למלא את המקום של עצמך. בחרו עובד אחר.",
  "member_leaves:deputy_inactive": "ממלא המקום צריך להיות עובד פעיל בעסק שאינו צופה בלבד. בחרו עובד אחר.",
  "member_leaves:deputy_absent": "ממלא המקום נעדר בחלק מהימים האלה. בחרו עובד אחר או שנו את התאריכים.",
  "task:deputy_owner": "ממלא מקום לא מעביר משימה לאחראי אחר. אפשר לסיים, לדחות ולערוך אותה.",
  // TASK-07: a team task, for a team the user may not give tasks to
  "task:team": "אפשר לתת משימה לצוות רק אם אתם חברים בו או מנהלים אותו.",
  // TASK-06 part B (migration task_subtasks): sub-tasks, one level, following the parent's record
  "task:subtask_depth": "תת-משימה היא רמה אחת בלבד: אי אפשר להוסיף תת-משימה לתת-משימה.",
  "task:parent": "משימת האב לא נמצאה, או שאין לכם הרשאה לערוך אותה.",
  "task:subtask_recurrence": "תת-משימה לא חוזרת. בחרו \"בלי חזרה\" לפני הקישור למשימת אב, או קבעו חזרה במשימת האב.",
  "task:subtask_callback": "משימת שיחה חוזרת לפנייה מטופס לא יכולה להיות תת-משימה או משימת אב.",
  "task:subtask_links": "תת-משימה שייכת לרשומה של משימת האב. כדי לשנות את הקישור, נתקו אותה ממשימת האב או שנו את משימת האב.",
  // LEAD-06 (migration lead_convert_map)
  "convert_map:invalid": "אפשר לבחור רק שדה מאותו סוג. רעננו את הדף ונסו שוב.",
  // DEAL-03 (migration deal_loss_reasons)
  "deal:lost_reason": "הסיבה שנבחרה כבר לא ברשימה. רעננו את הדף ובחרו שוב.",
  // DEAL-04 (migration deal_close_window)
  "deal:closed_at": "תאריך הסגירה לא יכול להיות בעתיד.",
  // stuck by time in stage (migration deal_stage_entered)
  "deal:snoozed_until": "אפשר לדחות עסקה ליום שאחרי היום, עד שנה קדימה.",
  // DEAL-11: the deal a follow-up continues is set once, to a live deal the user reads
  "deal:previous_deal": "העסקה הקודמת כבר לא זמינה. רעננו את הדף ונסו שוב.",
  // DQL-04: the first source of a lead (source, campaign, a UTM value) once set
  "lead:first_source_locked": "המקור הראשון של הליד נעול. רק בעלים או מנהל מערכת יכולים לשנות אותו.",
  "contact:first_source_locked": "המקור הראשון של איש הקשר נעול. רק בעלים או מנהל מערכת יכולים לשנות אותו.",
  // DEAL-07: the first-year value would pass the largest amount the system keeps
  "deal:amount_too_big": "שווי השנה הראשונה גדול מדי. הזינו את השווי בעצמכם.",
  // LEAD-04: a person picks only an offerable product (active, not archived)
  "lead:requested_product": "המוצר שנבחר כבר לא זמין. בחרו מוצר פעיל מהקטלוג.",
  // LEAD-04 / CAP-08: the products a form offers are this business's own
  "form:product_ids": "אחד המוצרים שנבחרו כבר לא נמצא בקטלוג. רעננו את הדף ובחרו שוב.",
  "form:product_categories": "אחת הקטגוריות שנבחרו כבר לא קיימת. רעננו את הדף ובחרו שוב.",
  // owner, 25 October 2026: over 100 active products the form must pick what it shows
  "form:products_over": "בטופס אפשר להציג עד 100 מוצרים פעילים. בחרו אילו מוצרים או קטגוריות יוצגו בטופס.",
  // TAX-02 follow-up (trigger org_bank_details_check): no value in the error, so the account never leaks
  "bank:invalid": "פרטי הבנק אינם תקינים. סניף: עד 4 ספרות. חשבון: 2 עד 20 ספרות, ויחד איתו שם הבנק והסניף.",
  // TAX-03 (migration vat_rates, app.document_vat_rate): a document dated before the first VAT rate
  "vat:before_table": VAT_BEFORE_TABLE,
  // ADM-01 (migration platform_vat_rates, vat_rates_guard): a rate whose day has begun is locked
  "vat:rate_in_force": VAT_RATE_FUTURE_ONLY,
  "vat:date_taken": 'כבר יש שיעור מע"מ שמתחיל בתאריך הזה. ערכו אותו או בחרו תאריך אחר.',
  // ADM-01 (migration platform_subprocessors, subprocessors_guard): an entry in force is locked; it ends from a future day
  "subprocessor:in_force": SUBPROCESSOR_IN_FORCE,
  // ADM-01: the DPA promises 14 days of notice before a new subprocessor
  "subprocessor:notice": SUBPROCESSOR_NOTICE,
  // ADM-01: an end day on or before the start day (guard, ahead of the table's check)
  "subprocessor:end_before_start": "תאריך הסיום צריך להיות אחרי תאריך התחילה.",
  // TAX-05 (migration tax_calc, app.document_totals); the app checks first with documentTotals() and its own texts
  "totals:invalid": "אי אפשר לחשב את הסכומים. בדקו את הכמויות, המחירים וההנחות.",
  // PRD-04 (migration product_lists)
  "product_categories:max": "אפשר לשמור עד 200 קטגוריות. מחקו קטגוריה שלא בשימוש כדי להוסיף חדשה.",
  "product_categories:depth": "אפשר לשים קטגוריה רק בתוך קטגוריה ראשית, ורק אם אין בתוכה קטגוריות אחרות (עד שתי רמות).",
  "product_units:max": "אפשר לשמור עד 50 יחידות מידה. מחקו יחידה שלא בשימוש כדי להוסיף חדשה.",
  // PL-02
  // PL-01 follow-up (migration price_list_vat): the VAT setting of a list that has prices
  "price_lists:vat_locked": "אי אפשר לשנות את הגדרת המע\"מ של מחירון שיש בו מחירים. כדי לעבוד אחרת, צרו מחירון חדש.",
  "price_list_lines:tiers": "אפשר לשמור עד 20 מדרגות כמות למוצר אחד במחירון. מחקו מדרגה כדי להוסיף חדשה.",
  // SEG-01 (migration segments)
  "segment_member:invalid": "אפשר להוסיף רשומות רק לסגמנט ידני, ורק מהסוג שלו (לידים או אנשי קשר).",
  "segment_members:max": "סגמנט ידני מחזיק עד 10,000 רשומות. הסירו רשומות או צרו סגמנט נוסף.",
  // DLI-01, DLI-02, PL-03 (migration deal_lines)
  "deal_lines:max": "אפשר עד 200 שורות מוצר בעסקה אחת. מחקו שורה כדי להוסיף חדשה.",
  "deal_lines:vat_mode": "הגדרת המע\"מ של השורות השתנתה בזמן שמילאתם. רעננו את הדף ונסו שוב.",
  "deal_lines:product": "המוצר שנבחר לא פעיל או בארכיון. בחרו מוצר פעיל מהקטלוג.",
  "deal_lines:price_list": "חסר המחירון שממנו נלקח המחיר. רעננו את הדף ונסו שוב.",
  // QUO-01, QUO-02 (migration quotes)
  "quote:contact": "אי אפשר לקשר את איש הקשר הזה להצעה. ייתכן שהוא בסל המחזור או שאין לכם גישה אליו.",
  "quote:company": "אי אפשר לקשר את החברה הזו להצעה. ייתכן שהיא בסל המחזור או שאין לכם גישה אליה.",
  // QUO-07
  "quote:not_sent": "קישור ללקוח נוצר רק להצעה שנשלחה. סמנו קודם את ההצעה כנשלחה.",
  "quote:closed": "ההצעה בוטלה או שתוקפה עבר, ולכן אין לה קישור ללקוח.",
  "quote:empty": "אי אפשר לשלוח הצעה בלי שורות. הוסיפו לפחות שורה אחת.",
  "quote:vat_unknown": 'עוד לא נקבע המעמד של העסק במע"מ, ולכן אי אפשר לשלוח את ההצעה. בעלי העסק קובעים אותו ב"הגדרות > מע"מ ופרטים למסמכים".',
  "quote_pdf:draft": "לטיוטה אין קובץ PDF. הקובץ נשמר כשההצעה נשלחת.",
  "quote_pdf:closed": "קובץ PDF נשמר רק להצעה שנשלחה ועדיין פתוחה (נשלחה או נצפתה).",
  "quote_pdf:invalid": "קובץ ה-PDF לא נשמר. נסו שוב בעוד רגע.",
  "quote:frozen": "אי אפשר לשנות מחירים, הנחה או מע\"מ בהצעה שכבר אינה טיוטה.",
  // QUO-16: the timeline entries of a sent, accepted or declined quote are history
  "activity:quote_entry": "רישום של הצעת מחיר בציר הזמן נכתב על ידי המערכת, ואי אפשר ליצור, לשנות או למחוק אותו.",
  // ORD-05b
  "activity:order_entry": "תשובת הלקוח להזמנה בציר הזמן נכתבת על ידי המערכת, ואי אפשר ליצור, לשנות או למחוק אותה.",
  "activity:money_entry": "רישום של מסמך או תשלום בציר הזמן נכתב על ידי המערכת, ואי אפשר ליצור, לשנות או למחוק אותו.",
  "activity:record_link_entry": "רישום על קישור שהוסר בציר הזמן נכתב על ידי המערכת, ואי אפשר ליצור, לשנות או למחוק אותו.",
  // QUO-12: versions of a sent quote
  "quote:no_redraft": "הצעה שנשלחה לא חוזרת לטיוטה. כדי לשנות אותה יוצרים גרסה חדשה.",
  "quote_version:draft": "זו טיוטה: אפשר לערוך אותה ישירות.",
  "quote_version:closed": "ההצעה כבר אושרה, נדחתה, בוטלה או פגה, ולכן אי אפשר ליצור לה גרסה חדשה.",
  // QUO-11: cancelling a sent quote (public.quote_cancel)
  "quote_cancel:draft": "טיוטה לא מבטלים אלא מוחקים.",
  "quote_cancel:accepted": "אי אפשר לבטל הצעה שהלקוח כבר אישר.",
  "quote_cancel:closed": "ההצעה כבר נדחתה או בוטלה.",
  // QUO-11: cancelling an accepted quote (public.quote_cancel_accepted, owners and admins)
  "quote_cancel:not_accepted": "רק הצעה שהלקוח אישר מבטלים כאן.",
  "quote_cancel:reason": "יש לכתוב סיבה לביטול (עד 500 תווים).",
  "quote_version:exists": "להצעה הזאת כבר יש גרסה חדשה. ממשיכים לעבוד על הגרסה החדשה.",
  "quote_version:not_sent": "גרסה חדשה נוצרת רק מהצעה שנשלחה.",
  "quote_version:parent": "גרסה חדשה שייכת לאותה עסקה ולאותו איש קשר.",
  "quote_version:fixed": "אי אפשר לשנות לאיזו הצעה הגרסה שייכת.",
  // GAP-10: addenda to an accepted quote
  "quote_addendum:not_accepted": "תוספת נוצרת רק להצעה שהלקוח אישר.",
  "quote_addendum:of_addendum": "אי אפשר ליצור תוספת לתוספת. יוצרים תוספת נוספת להצעה המקורית.",
  "quote_addendum:parent": "תוספת שייכת לאותה עסקה ולאותו איש קשר של ההצעה המקורית.",
  "quote_addendum:version": "גרסה חדשה של תוספת נשארת תוספת לאותה הצעה.",
  "quote_addendum:fixed": "אי אפשר להעביר תוספת להצעה אחרת.",
  // ORD-01 / ORD-02 / ORD-03
  "order:confirm": "טיוטה מקבלת מספר רק בכפתור \"אישור ההזמנה\".",
  "order:no_redraft": "הזמנה שאושרה לא חוזרת לטיוטה.",
  "order:cancelled": "הזמנה שבוטלה נשארת כפי שהיא: אי אפשר להחזיר אותה או לשנות בה דבר.",
  "order:frozen": "בהזמנה שאושרה אי אפשר לשנות שורות, מחירים או לקוח. שינוי מחיר עובר דרך תוספת להצעה.",
  "order:vat_locked": "אי אפשר לשנות את הגדרת המע\"מ של הזמנה שיש בה שורות.",
  "order:customer": "להזמנה צריך איש קשר או חברה.",
  "order:contact": "אי אפשר לקשר את איש הקשר הזה להזמנה. ייתכן שהוא בסל המחזור או שאין לכם גישה אליו.",
  "order:company": "אי אפשר לקשר את החברה הזו להזמנה. ייתכן שהיא בסל המחזור או שאין לכם גישה אליה.",
  "order:numbered": "הזמנה שאושרה לא נמחקת. אפשר לבטל אותה.",
  "order:empty": "אי אפשר לאשר הזמנה בלי שורות. הוסיפו לפחות שורה אחת.",
  "order:vat_unknown": 'עוד לא נקבע המעמד של העסק במע"מ, ולכן אי אפשר לאשר את ההזמנה. בעלי העסק קובעים אותו ב"הגדרות > מע"מ ופרטים למסמכים".',
  "order:quote_not_accepted": "הזמנה נוצרת מהצעה שהלקוח אישר.",
  "order:exists": "כבר נוצרה הזמנה מזה. פתחו אותה מכרטיס ההזמנות.",
  "order:deal_not_won": "הזמנה מעסקה נוצרת רק מעסקה שנסגרה בהצלחה.",
  "order:use_quote": "לעסקה יש הצעת מחיר שאושרה. יוצרים את ההזמנה מההצעה, כדי שהשורות והמחירים יהיו כפי שהלקוח אישר.",
  "order_lines:max": "אפשר עד 200 שורות בהזמנה אחת.",
  "order_lines:product": "המוצר שנבחר לא פעיל או בארכיון. בחרו מוצר פעיל מהקטלוג.",
  "quote_version:previous_decided": "הלקוח כבר אישר או דחה את ההצעה הקודמת, ולכן אי אפשר לשלוח את הגרסה הזאת. אפשר למחוק את הטיוטה.",
  "quote:superseded": "נשלחה כבר גרסה חדשה של ההצעה, ולכן אי אפשר לאשר או לדחות את הקודמת.",
  // GAP-09
  "quote:schedule_total": "לוח התשלומים צריך להגיע בדיוק ל-100% לפני שליחה. תקנו את האחוזים, או מחקו את הלוח.",
  "quote_schedule:over": "סך האחוזים בלוח התשלומים עובר 100%. הקטינו אחוז באחד התשלומים.",
  "quote_schedule:max": "אפשר עד 20 תשלומים בלוח אחד.",
  // ORD-05: the customer's link to an order
  "order_link:draft": "קישור ללקוח נוצר רק להזמנה שאושרה וקיבלה מספר.",
  // ORD-06 part two: documents and payments of an order
  "order_money:draft": "מסמכים ותשלומים רושמים רק בהזמנה שאושרה וקיבלה מספר.",
  "order_money:parent": "מסמך או תשלום של הזמנה נרשם על העסקה או איש הקשר של ההזמנה עצמה.",
  "order_link:cancelled": "להזמנה שבוטלה לא יוצרים קישור חדש.",
  "order_link:customer_deleted": "הלקוח של ההזמנה נמחק, ולכן אין לה קישור.",
  // ORD-04: an order's payment schedule
  "order:schedule_total": "לוח התשלומים צריך להגיע בדיוק ל-100% לפני אישור ההזמנה. תקנו את האחוזים, או מחקו את הלוח.",
  "order_schedule:over": "סך האחוזים בלוח התשלומים עובר 100%. הקטינו אחוז באחד התשלומים.",
  "order_schedule:max": "אפשר עד 20 תשלומים בלוח אחד.",
  "quote:vat_locked": "אי אפשר לשנות את הגדרת המע\"מ של הצעה שיש בה שורות. מחקו את השורות או צרו הצעה חדשה.",
  "quote_lines:max": "אפשר עד 200 שורות בהצעה אחת. מחקו שורה כדי להוסיף חדשה.",
  "quote_lines:product": "המוצר שנבחר לא פעיל או בארכיון. בחרו מוצר פעיל מהקטלוג.",
  "quote_lines:price_list": "חסר המחירון שממנו נלקח המחיר. רעננו את הדף ונסו שוב.",
  // RVW-50: an order line's price source and its price list must match (ORD-01, PL-03)
  "order_lines:price_list": "מקור המחיר והמחירון של השורה לא תואמים. רעננו את הדף ונסו שוב.",
  // RVW-50: the won window of an accepted quote (QUO-13, public.quote_win_deal / quote_lines_to_deal)
  "quote_deal:no_deal": "ההצעה לא שייכת לעסקה, ולכן אין עסקה לעדכן לפיה.",
  "quote_deal:not_accepted": "רק הצעה שהלקוח אישר מעדכנת את העסקה. רעננו את הדף ובדקו את מצב ההצעה.",
  // RVW-50 (found by the hint guard): a business in read-only mode, and a closed status picked as the default
  "org:read_only": "העסק במצב קריאה בלבד, ולכן אי אפשר לשמור שינויים. בעלי העסק רואים את הפרטים ב\"הגדרות > חבילה ושימוש\".",
  "lead_status:default_open": "רק סטטוס פתוח יכול להיות סטטוס ברירת המחדל.",
  // QUO-04 (migration quote_templates)
  "quote_template_lines:max": "אפשר עד 200 שורות בתבנית אחת.",
  "quote_templates:quote": "ההצעה לא נמצאה. רעננו את הדף ונסו שוב.",
  "quote_lines:order": "סדר השורות לא תקין. רעננו את הדף ונסו שוב.",
  // QUO-03 (migration number_sequences)
  "number_sequences:start_locked": "כבר ניתן מספר בסדרה הזו, ולכן אי אפשר לשנות את המספר ההתחלתי. אפשר לשנות את הקידומת.",
  "number_sequences:last_number": "אי אפשר להחזיר את המספור אחורה.",
  "number_sequences:fixed": "אי אפשר להעביר סדרת מספור לסוג אחר.",
  "number_sequences:not_forward": "המספר הבא החדש צריך להיות גבוה מהמספר הבא הנוכחי. רעננו את הדף ונסו שוב.",
  "number_sequences:not_used": "עדיין לא ניתן מספר בסדרה הזו. אפשר לשנות את המספר ההתחלתי.",
  "number_sequences:range": "המספר הבא צריך להיות עד 999,999,999.",
  "number_sequences:exhausted": "הסדרה הגיעה למספר 999,999,999 ואין בה עוד מספרים. אפשר לשנות את הקידומת, אבל לא להתחיל את המספור מחדש. לבירור פנו לתמיכה.",
  "number_sequences:delete": "אי אפשר למחוק סדרת מספור, כדי שמספר לא יחזור.",
  "org:closed": `העסק סגור, ולכן אי אפשר ליצור בו מסמך חדש. לבירור: ${SUPPORT_LINE}.`,
  // WA-01 (migration whatsapp_templates)
  "whatsapp_templates:max": "אפשר לשמור עד 50 תבניות. מחקו תבנית שלא בשימוש כדי להוסיף חדשה.",
  // CAL-08 (migration meeting_types)
  "meeting_types:max": "אפשר לשמור עד 50 סוגי פגישה. מחקו סוג שלא בשימוש כדי להוסיף חדש.",
  "meeting_type:product": "השירות שנבחר כבר לא פעיל בקטלוג. בחרו שירות פעיל, או השאירו בלי שירות.",
  "meeting:type": "סוג הפגישה שנבחר כבר לא ברשימה. רעננו את הדף ובחרו שוב.",
  // CAL-10: booking pages
  "booking_page:type": "סוג הפגישה שנבחר כבר לא פעיל. בחרו סוג אחר.",
  "booking_page:user": "אפשר לקבוע תורים רק עם חבר צוות פעיל שאינו צופה.",
  "booking_page:questions": "יש בעיה בשאלות המקדימות: לכל שאלה צריך נוסח, עד 200 תווים.",
  // BIZ-02 (migration business_cards)
  "business_card:rep": "כרטיס ביקור שייך למשתמש פעיל בעסק שאינו בהרשאת צפייה בלבד.",
  // BIZ-03 (migration qr_codes)
  "qr_code:target": "קוד QR פותח טופס אתר או דף קביעת תור של העסק. בחרו אחד מהם.",
  // SPD-07 (migration site_widgets)
  "site_widget:owner": "פניות מהכפתור באתר עוברות למשתמש פעיל בעסק שאינו בהרשאת צפייה בלבד.",
  "form:widget": "הטופס של הכפתור באתר משתנה רק דרך הגדרות הכפתור.",
  "form:card": "הטופס של כרטיס ביקור משתנה רק דרך הכרטיס עצמו.",
  "booking_page:no_hours": "אי אפשר להפעיל את הדף: לא הוגדרו שעות עבודה לנציג או לעסק, ובלי שעות אין זמנים פנויים. הגדירו שעות עבודה, או שמרו את הדף כשהוא כבוי.",
  // CON-03 follow-up: the roles of a contact on a deal
  // TASK-08
  "activity_types:max": "אפשר לשמור עד 50 סוגים. מחקו סוג שלא בשימוש כדי להוסיף חדש.",
  "activity_type:invalid": "הסוג שנבחר כבר לא ברשימה, או שאינו מתאים. רעננו את הדף ובחרו סוג אחר.",
  "deal_contact_roles:max": "אפשר לשמור עד 20 תפקידים. מחקו תפקיד שלא בשימוש כדי להוסיף חדש.",
  "deal_contact_role:invalid": "התפקיד שנבחר כבר לא ברשימה. רעננו את הדף ובחרו שוב.",
  // CAL-09 (migration meeting_series)
  "meeting_series:invalid": "לא הצלחנו לקבוע את הסדרה. בדקו את מספר הפגישות (2 עד 52) ונסו שוב.",
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
  // CON-01 (trigger contact_channels_payload_check)
  "contact_channel:primary": "המספר או הכתובת כבר רשומים כראשיים של איש הקשר.",
  "contact_channel:max": "אפשר לשמור עד 10 טלפונים נוספים ו-10 אימיילים נוספים לאיש קשר.",
  // CON-05 (trigger contact_companies_check)
  "contact_company:primary": "את החברה הראשית מחליפים או מסירים בפרטי איש הקשר.",
  "contact_company:max": "אפשר לקשר איש קשר לעד 50 חברות.",
  // TASK-06 (migration task_checklists)
  "task_checklist:max": "אפשר עד 100 שלבים במשימה אחת.",
  "checklist_templates:max": "אפשר לשמור עד 50 תבניות של רשימת תיוג. מחקו תבנית שלא בשימוש כדי להוסיף חדשה.",
  // CON-06 (trigger contact_relations_check, contact_relation_types_cap)
  "contact_relation:exists": "הקשר הזה כבר רשום בין שני אנשי הקשר.",
  "contact_relation:type": "סוג הקשר הזה כבר לא ברשימה. בחרו סוג אחר.",
  "contact_relation:max": "אפשר לשמור עד 50 קשרים לאיש קשר.",
  "contact_relation:lead_type": "ליד נרשם רק כמי שהפנה איש קשר.",
  "contact_relation_types:max": "אפשר לשמור עד 20 סוגי קשר.",
  // CNS-01, CNS-03 (trigger consents_prepare, guard consents_guard)
  "consent:subject": "הסכמה נרשמת לליד אחד או לאיש קשר אחד. רעננו את הדף ונסו שוב.",
  // owner's rules of 13 October 2026 (trigger consents_prepare)
  "consent:erasure_block": "האדם ביקש למחוק את פרטיו. רק הסכמה חדשה שהוא נותן בעצמו בטופס מבטלת את החסימה.",
  "consent:optout_locked": "האדם ביקש לא לקבל דיוור. רק הסכמה חדשה שהוא נותן בטופס, או ביטול של בעלים או מנהל מערכת עם מקור, מבטלים את זה.",
  "consent:lift_admin": "רק בעלים או מנהל מערכת יכולים לבטל הסרה מדיוור.",
  // a person's request after a completed erasure (function audit_erase_request)
  "erase:no_address_left": 'הפרטים של הרשומה כבר נמחקו, ולכן אין טלפון או אימייל לרשום ברשימת "לא לפנות". אם האדם פונה שוב, אפשר להוסיף אותו לרשימה בבקשה חדשה.',
  "consent:address_blocked": "אי אפשר לרשום הסכמה לכתובת הזאת. רק הסכמה שהאדם נותן בעצמו בטופס עם תיבת הסכמה תפתח אותה.",
  "consent:lift_nothing": "אין כאן הסרה מדיוור לבטל. אפשר לרשום הסכמה רגילה.",
  "consent:lift_note": "לביטול הסרה צריך לבחור מקור ולכתוב הערה קצרה.",
  "consent:method": "צריך לכתוב איך התקבלה ההסכמה.",
  "consent:no_address": "אין ברשומה טלפון או אימייל לערוץ הזה. הוסיפו אותו קודם, ואז רשמו את ההסכמה.",
  "consent:append_only": "אי אפשר לשנות רישום הסכמה קיים. אפשר לרשום מצב חדש.",
  // CNS-06 (consents_prepare; public.consent_blocklist_add / _remove; guard consent_blocklist_guard)
  "consent:blocklisted": "הכתובת ברשימת החסימה של העסק, ולכן אי אפשר לרשום לה הסכמה. אפשר להסיר אותה מהרשימה ב\"הגדרות > רשימת חסימה לדיוור\".",
  "consent_blocklist:channel": "יש לבחור ערוץ מהרשימה.",
  // PRV-01 (public.lead_retention_preview / _set / _keep)
  "retention:months": "מספר החודשים צריך להיות בין 6 ל-120.",
  "retention:confirm": "קודם בודקים כמה רשומות יושפעו, ואז מאשרים.",
  "retention:not_listed": "הרשומה כבר לא ברשימה של הסבב הזה. אם היא כבר הועברה לסל המחזור, אפשר לשחזר אותה משם.",
  "consent_blocklist:reason": "יש לבחור סיבה מהרשימה.",
  "consent_blocklist:removed_reason": "יש לבחור למה מסירים את הכתובת מהרשימה.",
  "consent_blocklist:empty": "יש להקליד טלפון או אימייל אחד לפחות.",
  "consent_blocklist:too_many": "אפשר להוסיף עד 500 כתובות בבת אחת. חלקו את הרשימה ונסו שוב.",
  "consent_blocklist:max": "רשימת החסימה מלאה (100,000 כתובות). הסירו כתובות שכבר לא צריכות להיות בה.",
  "consent_blocklist:gone": "הכתובת כבר הוסרה מהרשימה. רעננו את הדף.",
  "consent_blocklist:append_only": "אי אפשר לשנות רישום ברשימת החסימה.",
  // CNS-06 answer 4: the note of an entry
  "consent_blocklist:note": "ההערה ארוכה מדי: עד 200 תווים.",
  // CNS-05 (import_jobs_consent_check, public.import_record_consents)
  "import_consent:note": "כשמייבאים הסכמות צריך לבחור איך התקבלו ולכתוב פרטים על המקור.",
  "import_consent:entity": "הסכמות לדיוור מייבאים רק עם לידים או אנשי קשר.",
  "import_consent:undeclared": "כשמייבאים עמודת הסכמה צריך לבחור איך התקבלו ההסכמות. התחילו את הייבוא מחדש ובחרו.",
  "import_consent:too_many": "נשלחו יותר מדי הסכמות בבת אחת. נסו שוב.",
  // GAP-12: history in an import
  "import:original_date": "תאריך היצירה המקורי צריך להיות תאריך בין 1990 להיום.",
  "import:original_date_fixed": "תאריך היצירה המקורי נכתב רק בייבוא, ואי אפשר לשנות אותו.",
  "import_note:too_many": "נשלחו יותר מדי הערות בבת אחת. נסו שוב.",
  "import_note:items": "ההערות שנשלחו אינן תקינות. נסו שוב.",
  // WAB-07: an imported WhatsApp chat
  "whatsapp_import:body": "השיחה ריקה או ארוכה מדי לרשומה אחת.",
  "whatsapp_import:mention": "אי אפשר לתייג עובדים בשיחה מיובאת.",
  "whatsapp_import:occurred_at": "מועד השיחה בקובץ אינו תקין.",
  "whatsapp_import:meta": "פרטי השיחה אינם תקינים. נסו לייצא אותה שוב.",
  // CON-07: triggers companies_parent_check / companies_parent_tree
  "company:parent_invalid": "אי אפשר לשייך לחברה הזו: היא נמחקה, נמצאת בסל המחזור או שאין לכם גישה אליה.",
  "company:parent_cycle": "אי אפשר לשייך חברה לעצמה או לחברה שנמצאת תחתיה.",
  "company:parent_depth": "מבנה החברות עמוק מדי: אפשר עד 10 רמות של חברות ששייכות זו לזו.",
  // USR-04 (function sample_data_add)
  "sample:exists": "נתוני הדוגמה כבר נמצאים במערכת. אפשר למחוק אותם ולהוסיף מחדש.",
  "sample:changed": "אחת מרשומות הדוגמה השתנתה בזמן המחיקה. נסו שוב: רשומות ששיניתם לא נמחקות.",
  "sample:no_status": "אין סטטוס פתוח ללידים. הוסיפו סטטוס ב\"הגדרות > סטטוסים ומקורות\" ונסו שוב.",
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
  // CAL-07, GAP-01: hint org:suspended (a suspended, cancelled or deleted organization)
  [/the organization is not active/i, `העסק אינו פעיל כרגע. לבירור: ${SUPPORT_LINE}.`],
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

const UNIQUE_VALUE_TAKEN = "אחד הערכים כבר קיים ברשומה אחרת, והשדה מוגדר כייחודי.";

/** True for a refusal of a custom field marked unique (FLD-07), with or without the field's name. */
export function isUniqueFieldClash(error: unknown): boolean {
  const e = asErrorLike(error);
  if (!e || e.code !== "23505") return false;
  return (e.hint ?? "").trim() === "custom_field:unique" || /custom_unique_values_value/.test(e.message ?? "");
}

/**
 * Lead conversion (convert_lead) refused because a value carried to the new contact or deal is
 * already taken there (FLD-07): the clash is on the records the conversion creates, not on the lead.
 */
export function conversionErrorMessage(error: unknown, fallback: string): string {
  if (isUniqueFieldClash(error)) {
    const e = asErrorLike(error);
    const label = (e?.details ?? e?.detail ?? "").trim();
    const field = (e?.hint ?? "").trim() === "custom_field:unique" && label ? `בשדה "${label}" ` : "";
    return `הערך ${field}כבר קיים ברשומה אחרת, והשדה מוגדר כייחודי, ולכן אי אפשר להעביר אותו לאיש הקשר או לעסקה שנוצרים בהמרה. שנו את הערך בליד ונסו שוב.`;
  }
  return dbErrorMessage(error, fallback);
}

/**
 * FLD-07 (migration field_settings): custom field settings. The field's label, or a
 * number of records, travels in the error's detail (the label is the business's own
 * text, shown to its members anyway).
 */
export function customFieldMessage(error: unknown): string | null {
  const e = asErrorLike(error);
  if (!e) return null;
  const detail = (e.details ?? e.detail ?? "").trim();
  // two people saving the same value at the same moment: the constraint itself answers, without the field's name
  if (e.code === "23505" && !e.hint && /custom_unique_values_value/.test(e.message ?? "")) {
    return UNIQUE_VALUE_TAKEN;
  }
  switch ((e.hint ?? "").trim()) {
    case "custom_field:unique":
      return detail
        ? `הערך בשדה "${detail}" כבר קיים ברשומה אחרת, והשדה מוגדר כייחודי. בדקו את הערך, או חפשו את הרשומה הקיימת.`
        : UNIQUE_VALUE_TAKEN;
    case "custom_field:read_only":
      return detail
        ? `השדה "${detail}" לקריאה בלבד: אחרי שמולא אי אפשר לשנות או למחוק אותו. רעננו את הדף כדי לראות את הערך שנשמר.`
        : "אחד השדות לקריאה בלבד: אחרי שמולא אי אפשר לשנות או למחוק אותו. רעננו את הדף כדי לראות את הערך שנשמר.";
    case "custom_field:unique_existing": {
      const records = Number(detail);
      const count = Number.isInteger(records) && records > 0 ? `${records.toLocaleString("he-IL")} רשומות` : "כמה רשומות";
      return `אי אפשר להגדיר את השדה כייחודי: ${count} חולקות ערך עם רשומה אחרת. מתקנים או ממזגים אותן ומנסים שוב.`;
    }
    case "custom_field:unique_type":
      return "אפשר להגדיר כייחודי רק שדה מסוג טקסט קצר, מספר, אימייל, טלפון, קישור, תעודת זהות או ח.פ.";
    case "custom_field:unique_default":
      return "לשדה ייחודי אין ערך ברירת מחדל, כי כל רשומה חדשה הייתה מקבלת אותו ערך.";
    case "custom_field:default":
      return "ערך ברירת המחדל אינו מתאים לסוג השדה או לאפשרויות שלו. אם הסרתם אפשרות, בחרו ברירת מחדל אחרת קודם.";
    // FLD-06 part B (migration field_types_part_b): the field's label travels in the detail
    case "custom_field:record_link":
      return detail
        ? `הרשומה שנבחרה בשדה "${detail}" לא נמצאה, נמצאת בסל המחזור או שאין לכם גישה אליה. בחרו רשומה אחרת.`
        : "הרשומה המקושרת לא נמצאה, נמצאת בסל המחזור או שאין לכם גישה אליה. בחרו רשומה אחרת.";
    case "custom_field:file":
      return detail
        ? `הקובץ של השדה "${detail}" לא נמצא או שעדיין לא סיים לעלות. העלו אותו שוב.`
        : "הקובץ של השדה לא נמצא או שעדיין לא סיים לעלות. העלו אותו שוב.";
    // FLD-09 (migration conditional_fields)
    case "custom_field:condition":
      return "אי אפשר לשמור את התנאי: השדה הקובע צריך להיות שדה פעיל אחר, בלי תנאי משלו, והערך צריך להתאים לו. רעננו את הדף ונסו שוב.";
    default:
      return null;
  }
}

function looksLikeNetworkFailure(error: ErrorLike): boolean {
  const text = `${error.name ?? ""} ${error.message ?? ""}`;
  return (
    error.name === "AuthRetryableFetchError" ||
    /fetch failed|failed to fetch|networkerror|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(text)
  );
}

/** Hebrew message for an error returned by a table query or an RPC call. */
/** The Hebrew message of a plan hint (`feature:<key>` or `limit:<key>`), for screens that explain a lock up front. */
export function planHintMessage(hint: string): string | undefined {
  return LIMIT_MESSAGES[hint];
}

export function dbErrorMessage(error: unknown, fallback: string = GENERIC_ERROR): string {
  const e = asErrorLike(error);
  if (!e) {
    return fallback;
  }
  const code = e.code ?? "";

  const fieldMessage = customFieldMessage(e);
  if (fieldMessage) {
    return fieldMessage;
  }

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

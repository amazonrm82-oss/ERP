// What a column of an imported file can be mapped to, per object.
// Shared by the wizard (browser) and the import action (server).

export const IMPORT_ENTITIES = [
  { value: "lead", label: "לידים" },
  { value: "contact", label: "אנשי קשר" },
  { value: "company", label: "חברות" },
  // IMP-03
  { value: "deal", label: "עסקאות" },
  { value: "task", label: "משימות" },
  // PRD-05: owners and admins only (they write the catalog)
  { value: "product", label: "מוצרים" },
] as const;

export type ImportEntityKey = (typeof IMPORT_ENTITIES)[number]["value"];
/**
 * The objects imported with duplicate detection (leads, contacts, companies). Products (PRD-05),
 * deals and tasks (IMP-03) have their own paths.
 */
export type RecordImportEntity = Exclude<ImportEntityKey, "product" | "deal" | "task">;

export const DUPLICATE_MODES = [
  { value: "skip", label: "לדלג עליהן", hint: "רשומה שכבר קיימת (לפי טלפון או אימייל; בחברות לפי ח.פ. או שם) לא תיובא." },
  { value: "update", label: "לעדכן את הקיימת", hint: "השדות שמולאו בקובץ ידרסו את הקיימים. עדכונים לא מתבטלים בביטול הייבוא." },
  { value: "create", label: "ליצור בכל זאת", hint: "כל שורה תיצור רשומה חדשה, גם אם יש כפילות." },
] as const;

export type DuplicateModeKey = (typeof DUPLICATE_MODES)[number]["value"];

/** PRD-05: a product whose SKU is already in the catalog (or earlier in the file) is skipped; there is no other choice. */
export const PRODUCT_DUPLICATE_HINT = 'מוצר עם מק"ט שכבר קיים בקטלוג, או שכבר הופיע בקובץ, לא ייובא. מוצר בלי מק"ט תמיד נוצר.';

/**
 * IMP-03: deals and tasks have no key that tells two rows are the same record (names repeat),
 * so every row creates one; there is no other choice.
 */
export const DEAL_DUPLICATE_HINT = "כל שורה יוצרת עסקה חדשה. אין בדיקת כפילויות, כי לעסקאות אין מזהה קבוע כמו טלפון או מק\"ט.";
export const TASK_DUPLICATE_HINT = "כל שורה יוצרת משימה חדשה. אין בדיקת כפילויות.";

/** The duplicate rules an object offers in the wizard. */
export function duplicateModesFor(entity: ImportEntityKey): DuplicateModeKey[] {
  if (entity === "product") return ["skip"];
  if (entity === "deal" || entity === "task") return ["create"];
  return DUPLICATE_MODES.map((m) => m.value);
}

/** The table an import of the object writes into. */
export const IMPORT_TABLES = {
  lead: "leads",
  contact: "contacts",
  company: "companies",
  product: "products",
  deal: "deals",
  task: "tasks",
} as const satisfies Record<ImportEntityKey, string>;

export type ImportTarget = { key: string; label: string; synonyms: string[] };

const NAME = ["שם", "שם מלא", "name", "full name", "fullname", "שם הלקוח", "איש קשר", "contact"];
const FIRST = ["שם פרטי", "first name", "firstname", "first", "given name"];
const LAST = ["שם משפחה", "last name", "lastname", "last", "surname", "family name"];
const PHONE = ["טלפון", "נייד", "פלאפון", "סלולרי", "מספר טלפון", "phone", "mobile", "tel", "telephone", "phone number", "cell"];
const EMAIL = ["אימייל", "מייל", "דואל", "דוא\"ל", "email", "e-mail", "mail"];
const COMPANY = ["חברה", "שם החברה", "עסק", "company", "company name", "organization", "ארגון"];
const JOB = ["תפקיד", "job title", "title", "position", "role"];
const OWNER = ["אחראי", "בעלים", "נציג", "owner", "assigned to", "sales rep", "rep"];
// IMP-03: the record a deal or a task is linked to, by a key the file has
const CONTACT_KEY = ["איש קשר", "איש הקשר", "טלפון איש קשר", "אימייל איש קשר", "contact", "contact email", "contact phone", "לקוח"];
const COMPANY_KEY = ["חברה", "שם החברה", "עסק", "company", "company name", "organization", "ארגון", "דומיין", "domain"];

export const IMPORT_TARGETS: Record<ImportEntityKey, ImportTarget[]> = {
  lead: [
    { key: "full_name", label: "שם מלא", synonyms: NAME },
    { key: "first_name", label: "שם פרטי", synonyms: FIRST },
    { key: "last_name", label: "שם משפחה", synonyms: LAST },
    { key: "phone", label: "טלפון", synonyms: PHONE },
    { key: "email", label: "אימייל", synonyms: EMAIL },
    { key: "company_name", label: "שם החברה", synonyms: COMPANY },
    { key: "job_title", label: "תפקיד", synonyms: JOB },
    { key: "status", label: "סטטוס (לפי שם)", synonyms: ["סטטוס", "מצב", "status", "lead status"] },
    { key: "source", label: "מקור (לפי שם)", synonyms: ["מקור", "source", "lead source", "ערוץ"] },
    { key: "campaign", label: "קמפיין", synonyms: ["קמפיין", "campaign", "utm_campaign"] },
    { key: "message", label: "הודעה / הערות", synonyms: ["הודעה", "הערות", "הערה", "message", "notes", "note", "comments", "תיאור"] },
    { key: "owner", label: "אחראי (אימייל או שם)", synonyms: OWNER },
    // RVW-9: kept only when it is a name on the business's list of reasons
    {
      key: "disqualify_reason",
      label: 'סיבה ל"לא רלוונטי" (לפי שם מהרשימה)',
      synonyms: ["סיבה", "סיבת פסילה", "סיבה ללא רלוונטי", "סיבת אי רלוונטיות", "למה לא רלוונטי", "disqualify reason", "disqualification reason", "lost reason", "reason"],
    },
  ],
  contact: [
    { key: "full_name", label: "שם מלא (יפוצל לפרטי ומשפחה)", synonyms: NAME },
    { key: "first_name", label: "שם פרטי", synonyms: FIRST },
    { key: "last_name", label: "שם משפחה", synonyms: LAST },
    { key: "phone", label: "טלפון", synonyms: PHONE },
    { key: "email", label: "אימייל", synonyms: EMAIL },
    { key: "job_title", label: "תפקיד", synonyms: JOB },
    { key: "company", label: "חברה (לפי שם, תיווצר אם חסרה)", synonyms: COMPANY },
    { key: "birth_date", label: "יום הולדת", synonyms: ["תאריך לידה", "יום הולדת", "birthday", "birth date", "date of birth", "dob"] },
    { key: "owner", label: "אחראי (אימייל או שם)", synonyms: OWNER },
  ],
  company: [
    { key: "name", label: "שם החברה", synonyms: [...COMPANY, "שם"] },
    { key: "country", label: "מדינה (שם או קוד, למשל GB)", synonyms: ["מדינה", "ארץ", "country", "country code"] },
    { key: "tax_id", label: "ח.פ. / ע.מ. / מספר רישום", synonyms: ["ח.פ.", "חפ", "ח.פ", "ע.מ.", "עוסק מורשה", "מספר עוסק", "מספר רישום", "tax id", "vat", "company number", "registration number"] },
    { key: "phone", label: "טלפון", synonyms: PHONE },
    { key: "email", label: "אימייל", synonyms: EMAIL },
    { key: "website", label: "אתר", synonyms: ["אתר", "אתר אינטרנט", "website", "web", "url", "site"] },
    { key: "city", label: "עיר", synonyms: ["עיר", "ישוב", "יישוב", "city", "town"] },
    { key: "address_line", label: "כתובת", synonyms: ["כתובת", "רחוב", "address", "street"] },
    { key: "owner", label: "אחראי (אימייל או שם)", synonyms: OWNER },
  ],
  // PRD-05: the same headers the product export writes, so an exported file imports back
  product: [
    { key: "name", label: "שם המוצר", synonyms: ["שם", "שם מוצר", "מוצר", "שירות", "product", "product name", "name", "item"] },
    { key: "description", label: "תיאור", synonyms: ["תיאור", "פירוט", "description", "details"] },
    { key: "sku", label: 'מק"ט', synonyms: ['מק"ט', "מקט", "קוד מוצר", "קוד פריט", "sku", "item code", "product code", "code"] },
    { key: "category", label: "קטגוריה (לפי שם; חסרה תיווצר)", synonyms: ["קטגוריה", "קטגוריית מוצר", "category", "group", "קבוצה"] },
    { key: "kind", label: "סוג (מוצר, שירות, מנוי, חבילה)", synonyms: ["סוג", "סוג מוצר", "type", "kind"] },
    { key: "unit", label: "יחידת מידה (לפי שם מהרשימה)", synonyms: ["יחידת מידה", "יחידה", "unit", "uom", "unit of measure"] },
    { key: "price", label: "מחיר", synonyms: ["מחיר", "מחיר מכירה", "price", "sale price", "unit price"] },
    { key: "price_includes_vat", label: 'המחיר כולל מע"מ (כן / לא)', synonyms: ['המחיר כולל מע"מ', 'כולל מע"מ', "כולל מעמ", "includes vat", "price includes vat", "vat included"] },
    { key: "vat_kind", label: 'מע"מ (חייב, פטור, שיעור אפס)', synonyms: ['מע"מ', "מעמ", 'סוג מע"מ', "vat", "vat type", "tax"] },
    { key: "billing", label: "חיוב (חד-פעמי, חודשי, רבעוני, שנתי)", synonyms: ["חיוב", "אופן חיוב", "תדירות חיוב", "billing", "billing cycle"] },
    { key: "duration_minutes", label: "משך בדקות", synonyms: ["משך", "משך בדקות", "דקות", "duration", "minutes"] },
    { key: "barcode", label: "ברקוד", synonyms: ["ברקוד", "barcode", "ean", "upc"] },
    { key: "is_active", label: "פעיל (כן / לא)", synonyms: ["פעיל", "active", "is active", "status", "מצב"] },
  ],
  // IMP-03: the headers of the deals list export map back to these
  deal: [
    { key: "name", label: "שם העסקה", synonyms: ["שם", "שם עסקה", "עסקה", "deal", "deal name", "name", "title"] },
    { key: "amount", label: "ערך (₪)", synonyms: ["ערך", "סכום", "שווי", "amount", "value", "deal value", "price"] },
    { key: "pipeline", label: "פייפליין (לפי שם)", synonyms: ["פייפליין", "צנרת", "pipeline", "תהליך מכירה"] },
    { key: "stage", label: "שלב (לפי שם, בפייפליין)", synonyms: ["שלב", "stage", "deal stage", "מצב"] },
    { key: "expected_close_date", label: "תאריך סגירה צפוי", synonyms: ["תאריך סגירה צפוי", "סגירה צפויה", "expected close", "expected close date", "close date"] },
    { key: "closed_date", label: "תאריך סגירה בפועל (לעסקה שנסגרה)", synonyms: ["תאריך סגירה בפועל", "נסגרה בתאריך", "closed", "closed at", "closed date", "won date", "lost date"] },
    { key: "owner", label: "אחראי (אימייל או שם)", synonyms: OWNER },
    { key: "contact", label: "איש קשר (אימייל או טלפון)", synonyms: CONTACT_KEY },
    { key: "company", label: "חברה (שם או דומיין)", synonyms: COMPANY_KEY },
    { key: "source", label: "מקור (לפי שם)", synonyms: ["מקור", "source", "lead source", "ערוץ"] },
    { key: "tags", label: "תגיות (מופרדות בפסיק)", synonyms: ["תגיות", "תגית", "tags", "tag", "labels"] },
    { key: "billing_kind", label: "סוג עסקה (חד-פעמית, חודשית, שנתית)", synonyms: ["סוג עסקה", "חיוב", "billing", "billing kind", "recurring"] },
    { key: "recurring_amount", label: "סכום חוזר (₪)", synonyms: ["סכום חוזר", "סכום חודשי", "סכום שנתי", "recurring amount", "mrr"] },
    { key: "recurring_start_date", label: "תאריך התחלה (עסקה חוזרת)", synonyms: ["תאריך התחלה", "התחלה", "start date", "start"] },
    { key: "renewal_date", label: "תאריך חידוש", synonyms: ["תאריך חידוש", "חידוש", "renewal", "renewal date"] },
  ],
  // IMP-03: tasks have no custom fields and no tags
  task: [
    { key: "title", label: "מה צריך לעשות (כותרת)", synonyms: ["כותרת", "משימה", "מה לעשות", "נושא", "title", "task", "subject", "name"] },
    { key: "description", label: "פירוט", synonyms: ["פירוט", "תיאור", "הערות", "description", "details", "notes"] },
    { key: "task_type", label: "סוג (משימה, שיחה, פגישה, מעקב)", synonyms: ["סוג", "סוג משימה", "type", "task type"] },
    { key: "due_date", label: "תאריך יעד (אפשר עם שעה)", synonyms: ["תאריך יעד", "תאריך", "יעד", "due", "due date", "date", "deadline"] },
    { key: "due_time", label: "שעת יעד", synonyms: ["שעה", "שעת יעד", "time", "due time"] },
    { key: "priority", label: "עדיפות (גבוהה, רגילה, נמוכה)", synonyms: ["עדיפות", "דחיפות", "priority"] },
    { key: "status", label: "מצב (פתוחה, בוצעה)", synonyms: ["מצב", "סטטוס", "status", "done", "בוצעה"] },
    { key: "owner", label: "אחראי (אימייל או שם)", synonyms: OWNER },
    { key: "lead", label: "ליד (טלפון או אימייל)", synonyms: ["ליד", "טלפון ליד", "אימייל ליד", "lead", "lead phone", "lead email"] },
    { key: "contact", label: "איש קשר (אימייל או טלפון)", synonyms: CONTACT_KEY },
    { key: "company", label: "חברה (שם או דומיין)", synonyms: COMPANY_KEY },
    { key: "deal", label: "עסקה (שם מדויק)", synonyms: ["עסקה", "שם עסקה", "deal", "deal name"] },
  ],
};

export const CUSTOM_PREFIX = "cf:";

const normalize = (text: string) => text.trim().toLowerCase().replace(/[_\-.:]+/g, " ").replace(/\s+/g, " ");

/** The best target for each header, each target used once. "" = not imported. */
export function suggestMapping(headers: string[], targets: ImportTarget[]): string[] {
  const used = new Set<string>();
  return headers.map((header) => {
    const h = normalize(header);
    if (!h) return "";
    const match =
      targets.find((t) => !used.has(t.key) && (normalize(t.label) === h || t.synonyms.some((s) => normalize(s) === h))) ??
      targets.find((t) => !used.has(t.key) && t.synonyms.some((s) => normalize(s).length > 2 && h.includes(normalize(s))));
    if (match) {
      used.add(match.key);
      return match.key;
    }
    return "";
  });
}

export const MAX_IMPORT_ROWS = 50_000;
export const CHUNK_SIZE = 250;

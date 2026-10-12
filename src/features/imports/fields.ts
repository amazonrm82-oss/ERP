// What a column of an imported file can be mapped to, per object.
// Shared by the wizard (browser) and the import action (server).

export const IMPORT_ENTITIES = [
  { value: "lead", label: "לידים" },
  { value: "contact", label: "אנשי קשר" },
  { value: "company", label: "חברות" },
] as const;

export type ImportEntityKey = (typeof IMPORT_ENTITIES)[number]["value"];

export const DUPLICATE_MODES = [
  { value: "skip", label: "לדלג עליהן", hint: "רשומה שכבר קיימת (לפי טלפון או אימייל; בחברות לפי ח.פ. או שם) לא תיובא." },
  { value: "update", label: "לעדכן את הקיימת", hint: "השדות שמולאו בקובץ ידרסו את הקיימים. עדכונים לא מתבטלים בביטול הייבוא." },
  { value: "create", label: "ליצור בכל זאת", hint: "כל שורה תיצור רשומה חדשה, גם אם יש כפילות." },
] as const;

export type DuplicateModeKey = (typeof DUPLICATE_MODES)[number]["value"];

export type ImportTarget = { key: string; label: string; synonyms: string[] };

const NAME = ["שם", "שם מלא", "name", "full name", "fullname", "שם הלקוח", "איש קשר", "contact"];
const FIRST = ["שם פרטי", "first name", "firstname", "first", "given name"];
const LAST = ["שם משפחה", "last name", "lastname", "last", "surname", "family name"];
const PHONE = ["טלפון", "נייד", "פלאפון", "סלולרי", "מספר טלפון", "phone", "mobile", "tel", "telephone", "phone number", "cell"];
const EMAIL = ["אימייל", "מייל", "דואל", "דוא\"ל", "email", "e-mail", "mail"];
const COMPANY = ["חברה", "שם החברה", "עסק", "company", "company name", "organization", "ארגון"];
const JOB = ["תפקיד", "job title", "title", "position", "role"];
const OWNER = ["אחראי", "בעלים", "נציג", "owner", "assigned to", "sales rep", "rep"];

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

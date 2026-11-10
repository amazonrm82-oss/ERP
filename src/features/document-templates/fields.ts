import type { Gender } from "@/features/gender/gender";
import { MERGE_FIELD_PATTERN } from "@/features/message-templates/fields";
import { pickVariants } from "@/features/whatsapp/variants";

// SGN-01: the merge fields a document template may hold, a CLOSED list per record type: the business's fields (every
// type), then the record's own. The database refuses any other {text} (without ":" or "|") in a template's body
// (app.document_unknown_field over app.document_merge_fields(record_type), migration document_templates; hint
// document_template:field); tests/unit/document-templates.test.ts reads the latest migration and keeps the lists equal.
// The pattern is the message templates' one (MERGE_FIELD_PATTERN), so a HEB-01 gender block is never read as a field.

export const DOCUMENT_RECORD_TYPES = ["lead", "contact", "company", "deal"] as const;
export type DocumentRecordType = (typeof DOCUMENT_RECORD_TYPES)[number];

export function isDocumentRecordType(value: unknown): value is DocumentRecordType {
  return typeof value === "string" && (DOCUMENT_RECORD_TYPES as readonly string[]).includes(value);
}

export type DocumentField = { name: string; label: string };

export const DOCUMENT_BUSINESS_FIELDS: readonly DocumentField[] = [
  { name: "שם העסק", label: "שם העסק כפי שהלקוחות מכירים אותו" },
  { name: "השם הרשום של העסק", label: "השם הרשום בפרטי העסק למסמכים, ואם אין, שם העסק" },
  { name: "מספר העוסק", label: "מספר העוסק או החברה של העסק, מפרטי העסק למסמכים" },
  { name: "כתובת העסק", label: "הכתובת מפרטי העסק למסמכים" },
  { name: "טלפון העסק", label: "הטלפון של העסק" },
  { name: "אימייל העסק", label: "האימייל מפרטי העסק למסמכים" },
  { name: "שם הנציג", label: "השם שלכם (מי שמפיק את המסמך)" },
  { name: "תאריך היום", label: "התאריך שבו המסמך מופק" },
];

const FULL_NAME = { name: "שם מלא", label: "השם המלא" };
const FIRST_NAME = { name: "שם פרטי", label: "השם הפרטי" };
const PHONE = { name: "טלפון", label: "הטלפון" };
const EMAIL = { name: "אימייל", label: "האימייל" };

export const DOCUMENT_RECORD_FIELDS: Record<DocumentRecordType, readonly DocumentField[]> = {
  lead: [FULL_NAME, FIRST_NAME, PHONE, EMAIL, { name: "שם החברה", label: "שם החברה שנרשם בליד" }, { name: "תפקיד", label: "התפקיד" }],
  contact: [
    FULL_NAME,
    FIRST_NAME,
    { name: "שם משפחה", label: "שם המשפחה" },
    PHONE,
    EMAIL,
    { name: "תפקיד", label: "התפקיד" },
    { name: "כתובת", label: "הכתובת והעיר" },
    { name: "תעודת זהות", label: "מספר הזהות מפרטי החיוב" },
    { name: "כתובת לחיוב", label: "כתובת החיוב, ואם אין, של החברה שלו" },
    { name: "שם החברה", label: "החברה הראשית שלו" },
    { name: "תאריך לידה", label: "תאריך הלידה" },
  ],
  company: [
    { name: "שם החברה", label: "שם החברה" },
    { name: "מספר החברה", label: "מספר החברה או העוסק" },
    { name: "כתובת", label: "הכתובת והעיר" },
    PHONE,
    EMAIL,
    { name: "שם לחיוב", label: "השם לחיוב, ואם אין, שם החברה" },
    { name: "כתובת לחיוב", label: "כתובת החיוב" },
  ],
  deal: [
    { name: "שם העסקה", label: "שם העסקה" },
    { name: "סכום העסקה", label: "הסכום של העסקה" },
    { name: "תאריך סגירה צפוי", label: "תאריך הסגירה הצפוי" },
    { name: "שם מלא", label: "השם המלא של איש הקשר של העסקה" },
    { name: "שם פרטי", label: "השם הפרטי של איש הקשר של העסקה" },
    { name: "טלפון", label: "הטלפון של איש הקשר של העסקה" },
    { name: "אימייל", label: "האימייל של איש הקשר של העסקה" },
    { name: "שם החברה", label: "החברה של העסקה" },
  ],
};

/** The field names a template of this record type may hold, in order (= app.document_merge_fields(record_type)). */
export function documentFieldNames(type: DocumentRecordType): string[] {
  return [...DOCUMENT_BUSINESS_FIELDS, ...DOCUMENT_RECORD_FIELDS[type]].map((field) => field.name);
}

/** Every {text} of a body that is not a merge field of the record type, in order, each once. */
export function unknownDocumentFields(text: string, type: DocumentRecordType): string[] {
  const allowed = new Set(documentFieldNames(type));
  const found = new Set<string>();
  for (const match of text.matchAll(MERGE_FIELD_PATTERN)) {
    if (!allowed.has(match[1])) found.add(match[0]);
  }
  return [...found];
}

// REC-04's mark characters (ESCAPABLE in src/features/activities/markdown.ts): a value is shown as typed, never as a mark
const MARK_CHARACTER = /[\\*[\]()\-#_`]/g;

/** A value made safe for the cleaned Markdown: every mark character keeps its meaning as text; line breaks become spaces. */
export function markdownLiteral(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, " ").replace(MARK_CHARACTER, (char) => `\\${char}`);
}

export type DocumentValues = Readonly<Record<string, string | null | undefined>>;

/**
 * Picks each gender block's wording (HEB-01, neutral when the gender is not male or female), then replaces every merge
 * field that has a value with the value as literal text. A field without a value stays as it is, so the reader sees what
 * is still missing.
 */
export function fillDocument(body: string, values: DocumentValues, gender?: Gender | null): string {
  return pickVariants(body, gender).replace(MERGE_FIELD_PATTERN, (token, name: string) => {
    const value = values[name]?.trim();
    return value ? markdownLiteral(value) : token;
  });
}

/** The merge fields still in a filled body, in order, each once (only the type's own fields). */
export function unfilledDocumentFields(text: string, type: DocumentRecordType): string[] {
  const allowed = new Set(documentFieldNames(type));
  const found = new Set<string>();
  for (const match of text.matchAll(MERGE_FIELD_PATTERN)) {
    if (allowed.has(match[1])) found.add(match[0]);
  }
  return [...found];
}

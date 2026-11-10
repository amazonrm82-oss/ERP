import type { DocumentRecordType } from "./fields";

// SGN-01 (owner 3 November 2026, answer (67) ג): document templates, plan key `signatures` from "בסיס" up, 50 per business.
// A template is REC-04's cleaned Markdown with merge fields of its record type; nothing is sent, signed or stored from it
// yet (SGN-02).

export const DOCUMENT_TEMPLATES_PER_ORG = 50;
export const DOCUMENT_TEMPLATE_NAME_MAX = 80;
export const DOCUMENT_TEMPLATE_BODY_MAX = 20000;

export const DOCUMENT_KINDS = ["contract", "service_agreement", "joining_form", "health_declaration", "other"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  contract: "חוזה",
  service_agreement: "הסכם שירות",
  joining_form: "טופס הצטרפות",
  health_declaration: "הצהרת בריאות",
  other: "אחר",
};

export function isDocumentKind(value: unknown): value is DocumentKind {
  return typeof value === "string" && (DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** The record a template is filled from, in the default words (the screen uses the business's terms). */
export const DOCUMENT_RECORD_TYPE_LABELS: Record<DocumentRecordType, string> = {
  lead: "ליד",
  contact: "איש קשר",
  company: "חברה",
  deal: "עסקה",
};

export type DefaultDocumentTemplate = { name: string; kind: DocumentKind; recordType: DocumentRecordType; body: string };

// = app.seed_document_templates() (migration document_templates; unit test). DRAFT wording until the lawyer approves it.
export const DEFAULT_DOCUMENT_TEMPLATES: readonly DefaultDocumentTemplate[] = [
  {
    name: "הסכם שירות",
    kind: "service_agreement",
    recordType: "contact",
    body: [
      "**הסכם שירות**",
      "",
      'נערך ביום {תאריך היום} בין {השם הרשום של העסק}, מספר עוסק {מספר העוסק}, {כתובת העסק} (להלן: "העסק")',
      'לבין {שם מלא}, תעודת זהות {תעודת זהות}, {כתובת} (להלן: "הלקוח").',
      "",
      "1. העסק יספק ללקוח את השירות שסוכם ביניהם.",
      "2. הלקוח ישלם את התמורה שסוכמה, במועדים שסוכמו.",
      "3. כל צד רשאי לסיים את ההסכם בהודעה מראש של 30 ימים.",
      "",
      "לשאלות: {טלפון העסק}, {אימייל העסק}.",
    ].join("\n"),
  },
  {
    name: "חוזה",
    kind: "contract",
    recordType: "deal",
    body: [
      "**חוזה**",
      "",
      'נערך ביום {תאריך היום} בין {השם הרשום של העסק}, מספר עוסק {מספר העוסק} (להלן: "העסק")',
      'לבין {שם מלא}, {שם החברה} (להלן: "הלקוח").',
      "",
      "1. נושא החוזה: {שם העסקה}.",
      "2. התמורה: {סכום העסקה}.",
      "3. מועד משוער לסיום: {תאריך סגירה צפוי}.",
      "",
      "איש הקשר מטעם העסק: {שם הנציג}, {טלפון העסק}.",
    ].join("\n"),
  },
  {
    name: "טופס הצטרפות",
    kind: "joining_form",
    recordType: "contact",
    body: [
      "**טופס הצטרפות ל{שם העסק}**",
      "",
      "- שם מלא: {שם מלא}",
      "- תעודת זהות: {תעודת זהות}",
      "- טלפון: {טלפון}",
      "- אימייל: {אימייל}",
      "- כתובת: {כתובת}",
      "- תאריך לידה: {תאריך לידה}",
      "",
      "אני מאשר/ת שהפרטים נכונים. תאריך: {תאריך היום}",
    ].join("\n"),
  },
];

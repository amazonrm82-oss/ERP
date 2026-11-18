import { z } from "zod";

import { documentLineTotal } from "@/features/documents/details";
import { isCalendarDate } from "@/lib/calendar-date";
import { parseMoneyToAgorot } from "@/lib/format";

import { ISSUABLE_DOCUMENT_TYPES, type IssuableDocumentType } from "./providers/types";

// DOC-07 / DOC-08: the issue form's rules, shared by the page and the server action. Pure (no server, no provider), unit
// tested in tests/unit/invoice-issue.test.ts. The database stays the judge: app.invoice_issue_open re-checks every line and
// computes the totals itself.

export const ISSUE_SOURCE_KINDS = ["deal", "contact", "quote", "order"] as const;
export type IssueSourceKind = (typeof ISSUE_SOURCE_KINDS)[number];

export const isIssueSourceKind = (value: unknown): value is IssueSourceKind =>
  typeof value === "string" && (ISSUE_SOURCE_KINDS as readonly string[]).includes(value);

export const isIssuableType = (value: unknown): value is IssuableDocumentType =>
  typeof value === "string" && (ISSUABLE_DOCUMENT_TYPES as readonly string[]).includes(value);


/** Types a business that charges no VAT (exempt, nonprofit) never issues (app.invoice_issue_open, hint invoice:type_exempt). */
export const TAX_INVOICE_TYPES: readonly IssuableDocumentType[] = ["tax_invoice", "tax_invoice_receipt"];

/** The types the form offers: without VAT (chargesVat === false) no tax invoice; null (status not set) offers all. */
export function issuableTypesFor(chargesVat: boolean | null): IssuableDocumentType[] {
  return ISSUABLE_DOCUMENT_TYPES.filter((type) => chargesVat !== false || !TAX_INVOICE_TYPES.includes(type));
}

/** A due date belongs on a tax invoice or a proforma (DOC-01's rule, migration accounting_documents / PAY-02). */
export const issueTakesDueDate = (type: IssuableDocumentType) => type === "tax_invoice" || type === "proforma";

export const ISSUE_LINES_MAX = 200;

/** One line as the form edits it (texts, as typed). */
export type IssueLineDraft = {
  description: string;
  quantity: string;
  unitPrice: string;
  discount: string;
  vatExempt: boolean;
  /** owner (410) ב: the product the source line came from (goes to the provider as its product) */
  productId?: string | null;
};

/** One line as the database takes it. */
export type IssueLine = {
  description: string;
  quantity: number;
  unit_price_agorot: number;
  discount_agorot: number;
  vat_exempt: boolean;
  product_id?: string;
};

export const EMPTY_ISSUE_LINE: IssueLineDraft = { description: "", quantity: "1", unitPrice: "", discount: "", vatExempt: false };

const hasControl = (text: string) => [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

/** The line from its typed texts, or null while it is not a valid line yet. */
export function issueLineFrom(draft: IssueLineDraft): IssueLine | null {
  const description = draft.description.trim();
  const quantity = Number(draft.quantity.trim().replace(/,/g, ""));
  const unit = parseMoneyToAgorot(draft.unitPrice);
  const discount = draft.discount.trim() === "" ? 0 : parseMoneyToAgorot(draft.discount);
  if (description === "" || description.length > 500 || hasControl(description)) return null;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000 || Math.round(quantity * 1000) !== quantity * 1000) return null;
  if (unit === null || unit < 0 || discount === null || discount < 0) return null;
  if (documentLineTotal({ quantity, unitPriceAgorot: unit, discountAgorot: discount }) < 0) return null;
  const line: IssueLine = { description, quantity, unit_price_agorot: unit, discount_agorot: discount, vat_exempt: draft.vatExempt };
  return draft.productId ? { ...line, product_id: draft.productId } : line;
}

/** The form's hidden `lines` field: every row valid, 1..200 rows; null = the message to show. */
export function parseIssueLines(json: string): { ok: true; lines: IssueLine[] } | { ok: false; message: string } {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    return { ok: false, message: "השורות לא נקראו. נסו שוב." };
  }
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, message: "במסמך צריכה להיות לפחות שורה אחת." };
  if (rows.length > ISSUE_LINES_MAX) return { ok: false, message: `במסמך יש עד ${ISSUE_LINES_MAX} שורות.` };
  const lines: IssueLine[] = [];
  for (const [index, row] of rows.entries()) {
    const parsed = issueDraftSchema.safeParse(row);
    const line = parsed.success ? issueLineFrom(parsed.data) : null;
    if (!line) return { ok: false, message: `בשורה ${index + 1} חסר תיאור, או שהכמות או המחיר לא תקינים.` };
    lines.push(line);
  }
  return { ok: true, lines };
}

const issueDraftSchema = z.object({
  description: z.string().max(2000),
  quantity: z.string().max(40),
  unitPrice: z.string().max(40),
  discount: z.string().max(40),
  vatExempt: z.boolean(),
  productId: z.guid().nullable().optional(),
});

export const issueFormSchema = z
  .object({
    doc_type: z.string().refine(isIssuableType, "יש לבחור סוג מסמך."),
    doc_date: z.string().trim().refine(isCalendarDate, "יש לבחור תאריך."),
    due_date: z
      .string()
      .trim()
      .refine((value) => value === "" || isCalendarDate(value), "יש לבחור תאריך, או להשאיר ריק."),
    key: z.guid(),
  })
  .transform((value) => ({ ...value, doc_type: value.doc_type as IssuableDocumentType }));

export const ISSUE_FIELD_NAMES = ["doc_type", "doc_date", "due_date", "key"] as const;

/** DOC-08: what is missing on the customer, in the words the person reads. */
export const CUSTOMER_PROBLEM_TEXT: Record<string, string> = {
  name: "חסר שם הלקוח לחשבונית (שם לחשבונית, שם החברה או שם איש הקשר).",
  tax_id: "הלקוח הוא עסק ואין לו מספר עוסק או ח.פ. ממלאים אותו בפרטי החיוב של איש הקשר או בכרטיס החברה.",
  address: "הלקוח הוא עסק ואין לו כתובת. ממלאים כתובת לחשבונית או כתובת בכרטיס.",
};

export function customerProblemsText(problems: readonly string[]): string[] {
  return problems.map((code) => CUSTOMER_PROBLEM_TEXT[code] ?? "חסרים פרטי לקוח.");
}

/** A discount of a source line in agorot: as stored, else its basis points on the line's amount (half up). */
export function sourceLineDiscount(line: { quantity: number; unit_price_agorot: number; discount_bp: number | null; discount_agorot: number | null }): number {
  if (line.discount_agorot !== null) return line.discount_agorot;
  if (line.discount_bp === null) return 0;
  const amount = documentLineTotal({ quantity: line.quantity, unitPriceAgorot: line.unit_price_agorot, discountAgorot: 0 });
  return Math.floor((amount * line.discount_bp + 5000) / 10000);
}

/** A stored amount in agorot as the form types it ("1234.5"). */
export const agorotText = (agorot: number) => (agorot / 100).toFixed(2).replace(/\.00$/, "");

/** Why a request ended without a recorded document, in the person's words (codes of migration invoice_issue). */
/** = the sync log's reason for an auth code (provider-events.ts, isConnectionAuthCode) */
export const AUTH_REASON = "הספק לא קיבל את פרטי החיבור";

const ENDED_REASON: Record<string, string> = {
  "document:duplicate": "מסמך מאותו סוג ומספר כבר רשום בעסק",
  org_not_writable: "העסק במצב קריאה בלבד",
  "feature:documents": "המסמכים לא כלולים בחבילה",
  stale: "הבקשה נשארה פתוחה יותר מיממה ונסגרה ולא תופק. אם ניסיון קודם כבר הגיע לספק, המערכת רק תבדוק אצל הספק אם המסמך הופק (בלי להפיק מסמך חדש), ואם כן תרשום אותו כאן או תשלח הודעה",
  check_provider: "לא הצלחנו לבדוק אצל הספק אם ניסיון קודם הפיק את המסמך",
  closed: "הבקשה נסגרה ידנית ולא תופק. אם ניסיון קודם כבר הגיע לספק, המערכת רק תבדוק אצל הספק אם המסמך הופק (בלי להפיק מסמך חדש), ואם כן תרשום אותו כאן או תשלח הודעה",
  customer_erased: "פרטי הלקוח נמחקו (מחיקת פרטיות)",
  requester_gone: "מי שביקש את המסמך כבר לא חבר פעיל בעסק",
  "invoice:provider": "ספק החשבוניות לא זמין",
  "invoice:not_connected": "העסק כבר לא מחובר לספק החשבוניות",
  retries_spent: "הספק לא ענה גם אחרי כמה ניסיונות",
  job_dead: "הניסיונות לפנות לספק נגמרו",
  issued_after_close: "הבקשה נסגרה, אבל ניסיון קודם כבר הפיק את המסמך אצל הספק",
  provider_changed: "ספק החשבוניות של העסק התחלף",
  "invoice_credit:original": "המסמך המקורי בוטל, או שכבר לא הופק אצל הספק שהעסק מחובר אליו",
};

export type IssueRequestState = "pending" | "issued" | "unrecorded" | "failed" | "stale";

/** The request page's line for an ended request; null while it waits or once issued. */
export function issueEndedText(status: IssueRequestState, code: string | null, number: string | null): string | null {
  // DOC-16: the provider refused the business's key (the worker sends it as auth:<code>; the sync log's wording)
  const reason = code
    ? (Object.hasOwn(ENDED_REASON, code) ? ENDED_REASON[code] : undefined) ?? (/^((customer|product)_)?auth(:|$)/.test(code) ? AUTH_REASON : undefined)
    : undefined;
  if (status === "failed") return `המסמך לא הופק${reason ? `: ${reason}` : ", הספק סירב להפיק אותו"}. אפשר לתקן ולהפיק שוב.`;
  if (status === "unrecorded" || status === "stale") {
    return `ייתכן שהמסמך הופק אצל הספק${number ? ` (מספר ${number})` : ""} אבל הוא לא נרשם כאן${reason ? `: ${reason}` : ""}. אל תפיקו אותו שוב; בדקו אצל הספק ובמסמכים הרשומים, או פנו לתמיכה.`;
  }
  return null;
}

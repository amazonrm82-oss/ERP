// BAL-04 (owner, 1 November 2026, answer (2) א): the customer's statement as a PDF, made on our server for each request and
// never stored or counted in the PDF quota. Two documents in the shape of src/features/pdf:
// - the customer's: exactly what the statement page shows (public.statement_public's answer: the open debt documents, the
//   payments of the last 12 months, the totals, the credit, the bank details while the design shows them, the business's
//   details per the design). The answer holds no ids, and neither does the file.
// - the staff's (owner, 2 November 2026, answer (36) ב): exactly the customer's document, from public.statement_staff_view (the
//   same answer read with the user's session); the bank details only for owners and admins while the statement's switch is on
//   (answer (35) א); anyone else gets the line STATEMENT_BANK_ELSEWHERE in their place while the switch is on; with the switch
//   off neither (lead's decision, 2 November 2026: the line only where it is true).
// Pure, so it is unit tested (tests/unit/statement-pdf.test.ts reads a real file back).

import { ltr, type PdfBlock, type PdfDocument, type PdfLine, type PdfLogo, type PdfRow } from "@/features/pdf/document";
import { BANK_HEADING, type DocumentBank } from "@/features/quotes/bank";
import { bankPdfText } from "@/features/quotes/pdf";
import { formatDate, formatMoney } from "@/lib/format";

import { moreDocumentsText, morePaymentsText, overdueText, type PublicStatement } from "./public";

const day = (iso: string | null) => (iso ? formatDate(`${iso}T12:00:00Z`) : "");

/** The business's details on the letterhead, as the statement page shows them (the design already decided what is there). */
export type StatementBusiness = PublicStatement["business"];

/** The staff's file in place of the bank details they may not see (owner, 2 November 2026, answer (35) א). */
export const STATEMENT_BANK_ELSEWHERE = "פרטי הבנק מופיעים בדף שהלקוח רואה";

// direction marks and embeddings/isolates (U+200E, U+200F, U+202A-U+202E, U+2066-U+2069) and zero-width characters
// (U+200B-U+200D, U+2060, U+FEFF): a name the customer typed could otherwise show a different name or extension
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

/** Characters a file system refuses, invisible ones, and a length a download dialog keeps (code points, so no half emoji). */
function fileName(base: string): string {
  const clean = base
    .replace(INVISIBLE, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `${[...clean].slice(0, 150).join("").trim()}.pdf`;
}

/** "דף חשבון - <customer> - 01.11.2026.pdf" (the day as DD.MM.YYYY, from the business's today). */
export function statementPdfFileName(customerName: string | null, today: string): string {
  const [y, m, d] = today.split("-");
  const date = y && m && d ? `${d}.${m}.${y}` : today;
  // the customer's part is cut first (by code points, after cleaning), so the day always stays in the name
  const customer = [...(customerName ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim()].slice(0, 100).join("").trim();
  return fileName(["דף חשבון", customer || null, date].filter(Boolean).join(" - "));
}

function letterhead(business: StatementBusiness): PdfLine[] {
  const from: PdfLine[] = [];
  // the name always: without a logo or details the file still says whose it is (the page shows it the same way)
  from.push({ text: business.name, bold: true, size: 11 });
  if (business.legalName) from.push({ text: business.legalName });
  if (business.taxId) from.push({ text: `מספר עוסק או ח.פ.: ${ltr(business.taxId)}` });
  if (business.address) from.push({ text: business.address });
  if (business.phone) from.push({ text: ltr(business.phone) });
  if (business.email) from.push({ text: ltr(business.email) });
  return from;
}

function addressee(customerName: string | null, today: string): PdfLine[] {
  const meta: PdfLine[] = [];
  if (customerName) meta.push({ text: `לכבוד: ${customerName}`, bold: true });
  meta.push({ text: `נכון ל-${day(today)}`, muted: true });
  return meta;
}

function documentName(title: string, number: string | null): string {
  return number ? `${title} ${ltr(number)}` : title;
}

/** The bank details, or (the staff's file only) the line that stands in their place; nothing when there is neither. */
function bankBlock(bank: DocumentBank | null, line: string | null): PdfBlock[] {
  if (bank) return [{ kind: "section", title: BANK_HEADING, text: bankPdfText(bank) }];
  return line ? [{ kind: "section", title: BANK_HEADING, text: line }] : [];
}

const STATEMENT_COLUMNS = [
  { title: "מסמך", width: 26, align: "start" as const },
  { title: "תאריך", width: 14, align: "start" as const },
  { title: "לתשלום עד", width: 14, align: "start" as const },
  { title: "סכום", width: 14, align: "end" as const },
  { title: "יתרה", width: 14, align: "end" as const },
  { title: "איחור", width: 18, align: "start" as const },
];

/**
 * The customer's statement page as a PDF: the same content, the same words, no ids. The staff's file is the same document;
 * `bankLine` stands in for bank details the reader may not see (only when `data.bank` is null).
 */
export function publicStatementPdfDocument(data: PublicStatement, logo: PdfLogo | null, bankLine: string | null = null): PdfDocument {
  const blocks: PdfBlock[] = [];

  const totals: Array<{ label: string; value: string; strong?: boolean }> = [
    { label: "יתרה לתשלום", value: formatMoney(data.openAgorot), strong: true },
    { label: "מתוכה באיחור", value: formatMoney(data.overdueAgorot) },
  ];
  if (data.creditAgorot > 0) totals.push({ label: "זכות לטובתכם", value: formatMoney(data.creditAgorot) });
  blocks.push({ kind: "totals", rows: totals, notes: data.creditAgorot > 0 ? ["הזכות מוצגת בנפרד, ועוד לא קוזזה מהיתרה לתשלום."] : [] });

  if (data.lines.length === 0) {
    blocks.push({ kind: "paragraph", text: "אין חובות פתוחים. תודה!", bold: true });
  } else {
    blocks.push({ kind: "heading", text: "מסמכים פתוחים" });
    const rows: PdfRow[] = data.lines.map((line) => ({
      cells: [
        { text: documentName(line.title, line.number), bold: true },
        day(line.docDate),
        day(line.dueDate),
        formatMoney(line.amountAgorot),
        { text: formatMoney(line.balanceAgorot), bold: true },
        overdueText(line.overdueDays) ?? "",
      ],
    }));
    rows.push({ cells: [{ text: "סך הכול לתשלום", bold: true }, "", "", "", { text: formatMoney(data.openAgorot), bold: true }, ""] });
    blocks.push({ kind: "table", label: "מסמכים פתוחים", columns: STATEMENT_COLUMNS, rows });
    const more = moreDocumentsText(data.more);
    if (more) blocks.push({ kind: "paragraph", text: more, muted: true });
  }

  blocks.push({ kind: "heading", text: "תשלומים שהתקבלו ב-12 החודשים האחרונים" });
  blocks.push({
    kind: "table",
    label: "תשלומים שהתקבלו",
    columns: [
      { title: "תאריך", width: 30, align: "start" },
      { title: "אמצעי תשלום", width: 45, align: "start" },
      { title: "סכום", width: 25, align: "end" },
    ],
    rows: data.payments.map((payment) => ({ cells: [day(payment.paidOn), payment.method, formatMoney(payment.amountAgorot)] })),
    empty: "לא התקבלו תשלומים בתקופה הזו.",
  });
  const morePayments = morePaymentsText(data.paymentsMore);
  if (morePayments) blocks.push({ kind: "paragraph", text: morePayments, muted: true });

  blocks.push(...bankBlock(data.bank, bankLine));

  return {
    title: data.customerName ? `דף חשבון: ${data.customerName}` : "דף חשבון",
    heading: "דף חשבון",
    color: data.color,
    logo,
    from: letterhead(data.business),
    meta: addressee(data.customerName, data.today),
    blocks,
    closing: `הדף מציג את החובות הפתוחים ואת התשלומים שהתקבלו לפי הרישומים של ${data.business.name} נכון להיום. זה אינו מסמך חשבונאי. לשאלות על החשבון פנו לעסק.`,
    pageNote: `דף חשבון נכון ל-${day(data.today)}`,
  };
}

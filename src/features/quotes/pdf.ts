// QUO-06: a quote as a PDF document (src/features/pdf), the same content as the paper and screen document of QUO-05
// (components/quote-document.tsx): logo, business details, customer, lines with groups, stored totals (never added up
// here), the payment schedule, notes, terms and the design's header and footer texts. Pure, so it is unit tested.

import { ltr, type PdfBlock, type PdfDocument, type PdfLine, type PdfLogo, type PdfRow } from "@/features/pdf/document";
import { BILLING_LABELS } from "@/features/products/schema";
import { vatRateLabel } from "@/features/tax/rates";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";

import type { QuoteDocumentData } from "./design-server";
import type { QuoteLine } from "./queries";
import { percentText } from "./schedule";
import { noVatText } from "./schema";
import { groupSubtotals, isCounted } from "./totals";

function discountText(line: QuoteLine): string {
  if (line.discountBp) return `${formatNumber(line.discountBp / 100)}%`;
  if (line.discountAgorot) return formatMoney(line.discountAgorot);
  return "";
}

function lineNotes(line: QuoteLine): string | null {
  const notes = [
    line.isOptional ? (line.optionalSelected ? "רשות, כלולה בסיכום" : "רשות, לא כלולה בסיכום") : null,
    line.billing !== "one_time" ? BILLING_LABELS[line.billing] : null,
  ].filter(Boolean);
  const parts = [line.description?.trim() || null, notes.length > 0 ? notes.join(", ") : null].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** The file's name, as the customer and the business see it in their downloads. */
export function quotePdfFileName(numberDisplay: string | null, title: string): string {
  const base = numberDisplay ? `הצעת מחיר ${numberDisplay}` : `הצעת מחיר - ${title}`;
  // characters a file system refuses
  return `${base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150)}.pdf`;
}

export function quotePdfDocument(data: QuoteDocumentData, logo: PdfLogo | null): PdfDocument {
  const { design, business, customer, quote, lines } = data;
  const schedule = data.schedule ?? [];
  const sums = groupSubtotals(lines);
  const vatWord = quote.pricesIncludeVat ? 'כולל מע"מ' : 'לפני מע"מ';
  const showVat = quote.noVatReason === null && quote.vatRateBp !== null && quote.vatRateBp > 0;
  const optionalOut = lines.some((line) => line.kind === "item" && line.isOptional && !line.optionalSelected);

  const from: PdfLine[] = [];
  if (design.showBusinessDetails) {
    from.push({ text: business.name, bold: true, size: 11 });
    if (business.taxId) from.push({ text: `מספר עוסק או ח.פ.: ${ltr(business.taxId)}` });
    if (business.address) from.push({ text: business.address });
    if (business.phone) from.push({ text: ltr(business.phone) });
    if (business.email) from.push({ text: ltr(business.email) });
  } else if (!logo) {
    // without a logo or details the document still says whose it is
    from.push({ text: business.name, bold: true, size: 11 });
  }

  const meta: PdfLine[] = [];
  if (quote.status === "draft") meta.push({ text: "טיוטה, עוד ללא מספר" });
  else if (quote.numberDisplay) meta.push({ text: `מספר: ${ltr(quote.numberDisplay)}`, bold: true });
  meta.push({ text: `תאריך: ${formatDate(quote.quoteDate)}` });
  if (quote.validUntil) meta.push({ text: `בתוקף עד: ${formatDate(quote.validUntil)}` });

  const blocks: PdfBlock[] = [];
  if (design.headerText) blocks.push({ kind: "paragraph", text: design.headerText, size: 10 });

  const to: PdfLine[] = [{ text: "לכבוד", muted: true }];
  if (customer) {
    to.push({ text: customer.name, bold: true, size: 10.5 });
    if (customer.attention) to.push({ text: `לידי ${customer.attention}` });
    if (customer.taxId) to.push({ text: `מספר מזהה: ${ltr(customer.taxId)}` });
    if (customer.address) to.push({ text: customer.address });
    if (customer.email) to.push({ text: ltr(customer.email) });
  } else {
    to.push({ text: "—" });
  }
  blocks.push({ kind: "columns", start: to, end: [{ text: quote.title, bold: true, size: 12.5 }] });

  const rows: PdfRow[] = lines.map((line) =>
    line.kind === "group"
      ? { group: true, cells: [line.name, formatMoney(sums.get(line.id) ?? 0)] }
      : {
          cells: [
            { text: line.name, bold: true, sub: lineNotes(line) ?? undefined },
            `${formatNumber(line.quantity)}${line.unitName ? ` ${line.unitName}` : ""}`,
            formatMoney(line.unitPriceAgorot),
            discountText(line),
            { text: formatMoney(line.totalAgorot), bold: isCounted(line), muted: !isCounted(line) },
          ],
        },
  );
  blocks.push({
    kind: "table",
    label: `שורות ההצעה, המחירים ${vatWord}`,
    columns: [
      { title: "תיאור", width: 42, align: "start" },
      { title: "כמות", width: 12, align: "end" },
      { title: "מחיר ליחידה", width: 16, align: "end" },
      { title: "הנחה", width: 12, align: "end" },
      { title: "סכום", width: 18, align: "end" },
    ],
    rows,
    empty: "אין שורות בהצעה.",
  });

  const totals: Array<{ label: string; value: string; strong?: boolean }> = [{ label: `סכום השורות (${vatWord})`, value: formatMoney(quote.subtotalAgorot) }];
  if (quote.discountTotalAgorot > 0) totals.push({ label: "הנחה", value: `−${formatMoney(quote.discountTotalAgorot)}` });
  totals.push({ label: 'לפני מע"מ', value: formatMoney(quote.netTotalAgorot) });
  if (showVat) totals.push({ label: `מע"מ ${vatRateLabel(quote.vatRateBp ?? 0)}`, value: formatMoney(quote.vatAgorot) });
  totals.push({ label: 'סה"כ לתשלום', value: formatMoney(quote.totalAgorot), strong: true });
  const notes = [
    quote.noVatReason ? noVatText(quote.noVatReason, quote.noVatNote) : null,
    optionalOut ? "שורות רשות שלא סומנו אינן כלולות בסיכום." : null,
  ].filter((note): note is string => note !== null);
  blocks.push({ kind: "totals", rows: totals, notes });

  // GAP-09: the payment schedule, each step with its share of the total
  if (schedule.length > 0) {
    blocks.push({ kind: "heading", text: "לוח תשלומים" });
    blocks.push({
      kind: "table",
      label: "לוח תשלומים",
      columns: [
        { title: "תשלום", width: 46, align: "start" },
        { title: "מועד", width: 24, align: "start" },
        { title: "אחוז", width: 12, align: "end" },
        { title: "סכום", width: 18, align: "end" },
      ],
      rows: schedule.map((step) => ({
        cells: [
          { text: step.name, bold: true },
          [step.dueDate ? formatDate(`${step.dueDate}T12:00:00Z`) : null, step.milestone].filter(Boolean).join(", "),
          percentText(step.percentBp),
          formatMoney(step.amountAgorot),
        ],
      })),
    });
  }
  if (quote.notes) blocks.push({ kind: "section", title: "הערות", text: quote.notes });
  if (quote.terms) blocks.push({ kind: "section", title: "תנאים", text: quote.terms });

  return {
    title: quote.numberDisplay ? `הצעת מחיר ${quote.numberDisplay}` : `הצעת מחיר: ${quote.title}`,
    heading: "הצעת מחיר",
    color: data.color,
    logo,
    from,
    meta,
    blocks,
    closing: design.footerText,
    pageNote: quote.numberDisplay ? `הצעת מחיר ${quote.numberDisplay}` : null,
  };
}

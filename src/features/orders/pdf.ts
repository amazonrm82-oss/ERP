// ORD-05 PDF (owner, 1 November 2026, answer (1) ב): an order confirmation as a PDF document (src/features/pdf), the same
// content as the paper and screen document of ORD-05 part one (components/order-document.tsx): logo, business details,
// customer, delivery date and shipping address, lines with groups, stored totals (never added up here), the payment
// schedule, the bank details stored with the order, notes and the design's header and footer texts. It says "אינו חשבונית
// מס" under the title, by the total and at the foot of every page. Pure, so it is unit tested.

import { ltr, type PdfBlock, type PdfDocument, type PdfLine, type PdfLogo, type PdfRow } from "@/features/pdf/document";
import { BILLING_LABELS } from "@/features/products/schema";
import { BANK_HEADING } from "@/features/quotes/bank";
import { bankPdfText } from "@/features/quotes/pdf";
import { percentText } from "@/features/quotes/schedule";
import { groupSubtotals } from "@/features/quotes/totals";
import { vatRateLabel } from "@/features/tax/rates";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";

import type { OrderDocumentData } from "./document-server";
import type { Order, OrderLine } from "./queries";

/** The words the order document carries on its face (= NOT_A_TAX_INVOICE of components/order-document.tsx; unit test). */
export const ORDER_PDF_NOT_A_TAX_INVOICE = "אינו חשבונית מס";
const NOT_A_TAX_INVOICE = ORDER_PDF_NOT_A_TAX_INVOICE;

function discountText(line: OrderLine): string {
  if (line.discountBp) return `${formatNumber(line.discountBp / 100)}%`;
  if (line.discountAgorot) return formatMoney(line.discountAgorot);
  return "";
}

function lineNotes(line: OrderLine): string | null {
  const billing = line.billing !== "one_time" && line.billing in BILLING_LABELS ? BILLING_LABELS[line.billing as keyof typeof BILLING_LABELS] : null;
  const parts = [line.description?.trim() || null, billing].filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : null;
}

/** The file's name, as the customer and the business see it in their downloads. */
export function orderPdfFileName(numberDisplay: string | null): string {
  const base = numberDisplay ? `אישור הזמנה ${numberDisplay}` : "אישור הזמנה";
  // characters a file system refuses
  return `${base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150)}.pdf`;
}

export function orderPdfDocument(data: OrderDocumentData, logo: PdfLogo | null): PdfDocument {
  const { design, business, customer, order, lines } = data;
  const schedule = data.schedule ?? [];
  const sums = groupSubtotals(lines.map((line) => ({ ...line, isOptional: false, optionalSelected: false })));
  const vatWord = order.pricesIncludeVat ? 'כולל מע"מ' : 'לפני מע"מ';
  const showVat = order.noVatReason === null && order.vatRateBp !== null && order.vatRateBp > 0;

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

  const meta: PdfLine[] = [{ text: NOT_A_TAX_INVOICE, bold: true }];
  if (order.numberDisplay) meta.push({ text: `מספר: ${ltr(order.numberDisplay)}`, bold: true });
  else meta.push({ text: "טיוטה, עוד ללא מספר" });
  meta.push({ text: `תאריך: ${formatDate(order.orderDate)}` });
  if (order.deliveryDate) meta.push({ text: `מועד אספקה: ${formatDate(order.deliveryDate)}` });

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
  const shipping: PdfLine[] = order.shippingAddress ? [{ text: "כתובת משלוח", muted: true }, { text: order.shippingAddress }] : [];
  blocks.push({ kind: "columns", start: to, end: shipping });

  const rows: PdfRow[] = lines.map((line) =>
    line.kind === "group"
      ? { group: true, cells: [line.name, formatMoney(sums.get(line.id) ?? 0)] }
      : {
          cells: [
            { text: line.name, bold: true, sub: lineNotes(line) ?? undefined },
            `${formatNumber(line.quantity)}${line.unitName ? ` ${line.unitName}` : ""}`,
            formatMoney(line.unitPriceAgorot),
            discountText(line),
            { text: formatMoney(line.totalAgorot), bold: true },
          ],
        },
  );
  blocks.push({
    kind: "table",
    label: `שורות ההזמנה, המחירים ${vatWord}`,
    columns: [
      { title: "תיאור", width: 42, align: "start" },
      { title: "כמות", width: 12, align: "end" },
      { title: "מחיר ליחידה", width: 16, align: "end" },
      { title: "הנחה", width: 12, align: "end" },
      { title: "סכום", width: 18, align: "end" },
    ],
    rows,
    empty: "אין שורות בהזמנה.",
  });

  const totals: Array<{ label: string; value: string; strong?: boolean }> = [{ label: `סכום השורות (${vatWord})`, value: formatMoney(order.subtotalAgorot) }];
  if (order.discountTotalAgorot > 0) totals.push({ label: "הנחה", value: `−${formatMoney(order.discountTotalAgorot)}` });
  totals.push({ label: 'לפני מע"מ', value: formatMoney(order.netTotalAgorot) });
  if (showVat) totals.push({ label: `מע"מ ${vatRateLabel(order.vatRateBp ?? 0)}`, value: formatMoney(order.vatAgorot) });
  totals.push({ label: 'סה"כ', value: formatMoney(order.totalAgorot), strong: true });
  blocks.push({ kind: "totals", rows: totals, notes: [`מסמך זה ${NOT_A_TAX_INVOICE}.`] });

  // ORD-04: the payment schedule, each step with its share of the total
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
  // TAX-02: the bank details stored when the order got its number, while the design shows them
  const bank = design.showBankDetailsOrder ? order.bankDetails : null;
  if (bank) blocks.push({ kind: "section", title: BANK_HEADING, text: bankPdfText(bank) });
  if (order.notes) blocks.push({ kind: "section", title: "הערות", text: order.notes });

  return {
    title: order.numberDisplay ? `אישור הזמנה ${order.numberDisplay}` : "אישור הזמנה",
    heading: "אישור הזמנה",
    color: data.color,
    logo,
    from,
    meta,
    blocks,
    closing: design.footerText,
    footerNote: null,
    pageNote: order.numberDisplay ? `אישור הזמנה ${order.numberDisplay} · ${NOT_A_TAX_INVOICE}` : NOT_A_TAX_INVOICE,
  };
}

/**
 * Owner's answer (34) ב: the current PDF is out of date when the order's delivery date, shipping address or notes changed after it
 * was made (orders.pdf_content_changed_at, server-kept); public.order_pdf_store then makes a new version.
 */
export function orderPdfOutdated(order: Pick<Order, "pdfContentChangedAt">, file: { createdAt: string } | null): boolean {
  if (!file || !order.pdfContentChangedAt) return false;
  return new Date(order.pdfContentChangedAt).getTime() > new Date(file.createdAt).getTime();
}

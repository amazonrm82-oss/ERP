import { describe, expect, it } from "vitest";

import { PAYMENT_METHOD_LABELS } from "@/features/payments/schema";
import { renderPdf } from "@/features/pdf/render";
import { ledgerStatementPdfDocument, publicStatementPdfDocument, statementPdfFileName, type LedgerStatementData } from "@/features/statements/pdf";
import type { PublicStatement } from "@/features/statements/public";

import { pdfText } from "./pdf-text";

// BAL-04 (owner, 1 November 2026, answer (2) א): the statement PDF, made for each request and never stored. A real file is
// made and read back (tests/unit/pdf-text.ts): every line is drawn left to right in visual order, so Hebrew is expected
// reversed. The customer's file holds what the page shows; the staff's file holds the card's ledger.

// an amount as the file draws it: the sign, a no-break space, the number (the RLM marks are not drawn)
const nis = (n: string) => `₪\u00a0${n}`;
const visual = (hebrew: string) => [...hebrew].reverse().join("");

function statement(docs: number, payments: number): PublicStatement {
  return {
    business: {
      name: "חברת הדוגמה",
      legalName: 'חברת הדוגמה בע"מ',
      taxId: "512345678",
      address: "רחוב הרצל 1, תל אביב 6100000",
      phone: "+972-3-555-1234",
      email: "office@example.co.il",
    },
    logoPath: null,
    color: "#1e56d6",
    customerName: "ישראל ישראלי",
    today: "2026-11-01",
    lines: Array.from({ length: docs }, (_, i) => ({
      key: `doc-${i + 1}`,
      title: i % 7 === 0 ? "חשבון עסקה" : "חשבונית מס",
      number: `INV-${1000 + i}`,
      docDate: "2026-09-15",
      dueDate: i % 3 === 0 ? null : "2026-10-15",
      amountAgorot: 123450,
      balanceAgorot: 100000,
      overdueDays: i % 3 === 0 ? 0 : 17,
    })),
    more: docs > 50 ? 3 : 0,
    payments: Array.from({ length: payments }, (_, i) => ({
      key: `pay-${i + 1}`,
      paidOn: "2026-08-01",
      method: i % 2 === 0 ? PAYMENT_METHOD_LABELS.transfer : PAYMENT_METHOD_LABELS.cheque,
      amountAgorot: 50000,
    })),
    paymentsMore: 0,
    bank: { bankName: "בנק לדוגמה", branch: "800", account: "12345678", accountName: "חברת הדוגמה" },
    openAgorot: 6000000,
    overdueAgorot: 4000000,
    creditAgorot: 25000,
    builtWith: true,
  };
}

const pieces = (pages: ReturnType<typeof pdfText>) => pages.flatMap((page) => page.pieces.map((p) => p.text));

describe("the customer's statement PDF, read back from a real file (BAL-04)", () => {
  it("has the page's content on several pages, with the table's header on each page it continues on", async () => {
    const bytes = await renderPdf(publicStatementPdfDocument(statement(60, 30), null));
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const pages = pdfText(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const all = pieces(pages);

    expect(all).toContain("ןובשח ףד");
    expect(all).toContain(visual("חברת הדוגמה"));
    expect(all).toContain("+972-3-555-1234");
    expect(all).toContain("office@example.co.il");
    expect(all).toContain("ילארשי לארשי :דובכל");
    // totals, overdue and the credit kept apart
    expect(all).toContain(visual("יתרה לתשלום"));
    expect(all).toContain(visual("מתוכה באיחור"));
    expect(all).toContain(visual("זכות לטובתכם"));
    expect(all).toContain(nis("60,000"));
    expect(all).toContain(nis("1,234.50"));
    // a document number stays left to right inside the Hebrew title
    expect(all).toContain("INV-1001 סמ תינובשח");
    expect(all).toContain("םימי 17 לש רוחיאב");
    // the "more" note, the payments and the bank details
    expect(all).toContain(".םתוא םיללוכ הלעמל םימוכסה .ןאכ םיגצומ אלש םיחותפ םיכמסמ 3 דועו");
    expect(all).toContain("םינורחאה םישדוחה 12-ב ולבקתהש םימולשת");
    expect(all).toContain(visual(PAYMENT_METHOD_LABELS.transfer));
    expect(all).toContain(visual("פרטים להעברה בנקאית"));
    expect(all).toContain("12345678 :ןובשח רפסמ");
    // the documents table's header on every page holding its rows
    const docPages = pages.filter((page) => page.pieces.some((p) => p.text.includes("INV-")));
    expect(docPages.length).toBeGreaterThanOrEqual(2);
    for (const page of docPages) expect(page.pieces.map((p) => p.text)).toContain(visual("לתשלום עד"));
    pages.forEach((page, i) => expect(page.pieces.map((p) => p.text)).toContain(`${pages.length} ךותמ ${i + 1} דומע`));
    expect(all.join("\n")).not.toContain("�");
  });

  it("without debts, payments, credit or bank details still makes a valid one-page file", async () => {
    const data = { ...statement(0, 0), bank: null, creditAgorot: 0, openAgorot: 0, overdueAgorot: 0 };
    const doc = publicStatementPdfDocument(data, null);
    expect(doc.blocks.some((b) => b.kind === "section")).toBe(false);
    const pages = pdfText(await renderPdf(doc));
    expect(pages).toHaveLength(1);
    const all = pieces(pages);
    expect(all).toContain("!הדות .םיחותפ תובוח ןיא");
    expect(all).toContain(".וזה הפוקתב םימולשת ולבקתה אל");
    expect(all).not.toContain(visual("זכות לטובתכם"));
  });

  it("names the file after the customer and the business's day", () => {
    expect(statementPdfFileName("ישראל ישראלי", "2026-11-01")).toBe("דף חשבון - ישראל ישראלי - 01.11.2026.pdf");
    expect(statementPdfFileName(null, "2026-11-01")).toBe("דף חשבון - 01.11.2026.pdf");
    expect(statementPdfFileName('א/ב "ג"', "2026-11-01")).toBe("דף חשבון - א ב ג - 01.11.2026.pdf");
  });
});

function ledgerData(lines: number): LedgerStatementData {
  const base = statement(0, 0);
  return {
    business: base.business,
    color: null,
    customerName: "לקוח בדיקה",
    today: "2026-11-01",
    overdueAgorot: 30000,
    aging: { current: 10000, d1_30: 30000, d31_60: 0, d61_90: 0, d91_plus: 0 },
    bank: null,
    ledger: {
      allowed: true,
      partial: false,
      from: "2025-11-01",
      to: "2026-11-01",
      opening: 0,
      shown_opening: 0,
      truncated: false,
      debit: 1000000,
      credit: 960000,
      closing: 40000,
      open_debt: 40000,
      credit_balance: 0,
      lines: Array.from({ length: lines }, (_, i) =>
        i % 2 === 0
          ? { kind: "document" as const, id: `d${i}`, date: "2026-03-01", type: "tax_invoice", label: `${2000 + i}`, status: "active", invoice_number: null, proforma_number: null, amount: 50000, debit: 50000, credit: 0, balance: 50000 }
          : { kind: "payment" as const, id: `p${i}`, date: "2026-03-05", type: "cash", label: null, status: "cancelled", invoice_number: null, proforma_number: null, amount: 48000, debit: 0, credit: 0, balance: 50000 },
      ),
    },
  };
}

describe("the staff's statement PDF (BAL-04, the card's ledger)", () => {
  it("shows the totals, the aging and the ledger with its running balance over several pages", async () => {
    const pages = pdfText(await renderPdf(ledgerStatementPdfDocument(ledgerData(120), null)));
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const all = pieces(pages);
    expect(all).toContain(visual("יתרת חוב פתוחה"));
    expect(all).toContain(visual("יתרת פתיחה"));
    expect(all).toContain(visual("סך התקופה"));
    expect(all).toContain("םוי 90 לעמ");
    expect(all).toContain(nis("400"));
    // a cancelled payment says so, as on the card
    expect(all.some((p) => p.includes(visual("לא נספר")))).toBe(true);
    const ledgerPages = pages.filter((page) => page.pieces.some((p) => p.text.includes("2010")));
    expect(ledgerPages.length).toBeGreaterThanOrEqual(1);
    const rowPages = pages.filter((page) => page.pieces.some((p) => p.text.includes(visual("חשבונית מס"))));
    expect(rowPages.length).toBeGreaterThanOrEqual(2);
    for (const page of rowPages) expect(page.pieces.map((p) => p.text)).toContain(visual("פירוט"));
    expect(all.join("\n")).not.toContain("�");
  });

  it("leaves the aging out when nothing is open", () => {
    const data = ledgerData(2);
    data.ledger = { ...data.ledger, open_debt: 0 };
    data.aging = null;
    expect(ledgerStatementPdfDocument(data, null).blocks.some((b) => b.kind === "table" && b.label === "גיול החוב")).toBe(false);
  });
});

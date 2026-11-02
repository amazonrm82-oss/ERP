import { describe, expect, it } from "vitest";

import { PAYMENT_METHOD_LABELS } from "@/features/payments/schema";
import { renderPdf } from "@/features/pdf/render";
import { publicStatementPdfDocument, STATEMENT_BANK_ELSEWHERE, statementPdfFileName } from "@/features/statements/pdf";
import type { PublicStatement } from "@/features/statements/public";
import { staffStatementFrom } from "@/features/statements/staff";

import { pdfText } from "./pdf-text";

// BAL-04 (owner, 1 November 2026, answer (2) א): the statement PDF, made for each request and never stored. A real file is
// made and read back (tests/unit/pdf-text.ts): every line is drawn left to right in visual order, so Hebrew is expected
// reversed. The customer's file holds what the page shows; since 2 November 2026 the staff's file is the same document.

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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Review (BAL-04): the file never carries the page's own keys ("doc-1", "pay-1") or any uuid. */
function expectNoIds(texts: string[]) {
  const joined = texts.join("\n");
  expect(joined).not.toMatch(/doc-\d|pay-\d|\d-cod|\d-yap/);
  expect(joined).not.toMatch(UUID);
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
    expectNoIds(all);
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

  it("drops direction and zero-width characters and cuts a long name by code points, never inside an emoji", () => {
    // a right-to-left override would show "fdp.exe" as something else; marks and zero-width characters go
    expect(statementPdfFileName("ישראל\u202eexe.pdf\u202c \u200fכהן\u200b\u2066\ufeff", "2026-11-01")).toBe("דף חשבון - ישראלexe.pdf כהן - 01.11.2026.pdf");
    // the 100th code point of the name is an emoji (a surrogate pair): kept whole, and the day stays
    const name = `${"א".repeat(99)}😀😀`;
    const file = statementPdfFileName(name, "2026-11-01");
    expect(file).toBe(`דף חשבון - ${"א".repeat(99)}😀 - 01.11.2026.pdf`);
    expect(file).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    expect(file).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/);
  });
});

/** A raw answer of public.statement_staff_view (statement_public's shape plus the staff keys). */
function staffAnswer(extra: Record<string, unknown> = {}) {
  return {
    allowed: true,
    partial: false,
    business: { name: "חברת הדוגמה", legal_name: null, tax_id: null, address_line: null, city: null, postal_code: null, phone: null, email: null },
    brand: { logo: null, color: null },
    customer: { name: "ישראל ישראלי" },
    today: "2026-11-02",
    currency: "ILS",
    documents: [{ type: "tax_invoice", number: "INV-7", doc_date: "2026-09-01", due_date: "2026-10-01", amount_agorot: 10000, balance_agorot: 6000, overdue_days: 32 }],
    more: 0,
    payments: [{ paid_on: "2026-10-05", method: "transfer", amount_agorot: 4000 }],
    payments_more: 0,
    bank: null,
    bank_elsewhere: true,
    totals: { open_agorot: 6000, overdue_agorot: 6000, credit_agorot: 0 },
    built_with: false,
    ...extra,
  };
}

describe("the staff's statement PDF (BAL-04, owner 2 November 2026: the customer's document)", () => {
  it("reads the view's refusals and its content", () => {
    expect(staffStatementFrom({ allowed: false })).toEqual({ state: "not-allowed" });
    expect(staffStatementFrom({ allowed: true, partial: true })).toEqual({ state: "partial" });
    expect(staffStatementFrom({ allowed: true, partial: false, refused: "company" })).toEqual({ state: "company" });
    expect(staffStatementFrom({ allowed: true, partial: false, refused: "not_found" })).toEqual({ state: "not-found" });
    expect(staffStatementFrom({ allowed: true, partial: false })).toBeNull();
    expect(staffStatementFrom(null)).toBeNull();
    const ok = staffStatementFrom(staffAnswer());
    expect(ok?.state).toBe("ok");
    if (ok?.state !== "ok") return;
    expect(ok.bankElsewhere).toBe(true);
    expect(ok.statement.lines).toHaveLength(1);
    expect(ok.statement.bank).toBeNull();
    const admin = staffStatementFrom(staffAnswer({ bank_elsewhere: false, bank: { bank_name: "בנק", bank_branch: "1", bank_account: "999", bank_account_name: null } }));
    expect(admin?.state === "ok" && admin.bankElsewhere).toBe(false);
    expect(admin?.state === "ok" && admin.statement.bank?.account).toBe("999");
  });

  it("prints the line in place of the bank details, never both, and no ids", async () => {
    const data = { ...statement(3, 2), bank: null };
    const doc = publicStatementPdfDocument(data, null, STATEMENT_BANK_ELSEWHERE);
    expect(doc.blocks.filter((b) => b.kind === "section")).toEqual([{ kind: "section", title: "פרטים להעברה בנקאית", text: STATEMENT_BANK_ELSEWHERE }]);
    const all = pieces(pdfText(await renderPdf(doc)));
    expect(all).toContain(visual(STATEMENT_BANK_ELSEWHERE));
    expect(all).not.toContain("12345678 :ןובשח רפסמ");
    expectNoIds(all);

    // an owner or admin with the switch on: the details, and the line is not printed
    const withBank = publicStatementPdfDocument(statement(3, 2), null, null);
    const sections = withBank.blocks.filter((b) => b.kind === "section");
    expect(sections).toHaveLength(1);
    expect(JSON.stringify(sections)).not.toContain(STATEMENT_BANK_ELSEWHERE);
    expect(JSON.stringify(sections)).toContain("12345678");
    // the details win if both arrive
    expect(JSON.stringify(publicStatementPdfDocument(statement(1, 1), null, STATEMENT_BANK_ELSEWHERE).blocks)).not.toContain(STATEMENT_BANK_ELSEWHERE);
  });

  it("is the customer's document: the same blocks as the customer's file", () => {
    const data = statement(5, 4);
    expect(publicStatementPdfDocument(data, null, null)).toEqual(publicStatementPdfDocument(data, null));
  });
});

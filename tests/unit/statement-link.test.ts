import { describe, expect, it } from "vitest";

import { overdueText, publicStatementFrom } from "@/features/statements/public";
import { statementLinkMessage, statementMailtoHref, statementWhatsappHref } from "@/features/statements/share";
import { redactPublicPath } from "@/lib/request-error-log";

// BAL-04: the customer's statement page reads public.statement_public's answer; the link's token never reaches a log line.

const ANSWER = {
  business: { name: "נגריית הצפון", legal_name: "נגריית הצפון בע\"מ", tax_id: "515555555", address_line: "הגפן 3", city: "חיפה", postal_code: null, phone: "04-1234567", email: null },
  brand: { logo: null, color: "#225588" },
  customer: { name: "דנה כהן" },
  today: "2026-11-01",
  currency: "ILS",
  documents: [
    { type: "tax_invoice", number: "1001", doc_date: "2026-09-01", due_date: "2026-10-01", amount_agorot: 10000, balance_agorot: 6000, overdue_days: 31 },
    { type: "opening_balance", number: null, doc_date: "2026-01-01", due_date: null, amount_agorot: 4000, balance_agorot: 4000, overdue_days: 0 },
  ],
  more: 0,
  totals: { open_agorot: 10000, overdue_agorot: 6000, credit_agorot: 0 },
  built_with: true,
};

describe("the statement page's answer (BAL-04)", () => {
  it("reads the answer into the page's shape, with Hebrew document names", () => {
    const page = publicStatementFrom(ANSWER)!;
    expect(page.business).toEqual({ name: "נגריית הצפון", legalName: "נגריית הצפון בע\"מ", taxId: "515555555", address: "הגפן 3, חיפה", phone: "04-1234567", email: null });
    expect(page.lines.map((l) => [l.key, l.title, l.number, l.balanceAgorot])).toEqual([
      ["doc-1", "חשבונית מס", "1001", 6000],
      ["doc-2", "יתרת פתיחה", null, 4000],
    ]);
    expect([page.openAgorot, page.overdueAgorot, page.creditAgorot]).toEqual([10000, 6000, 0]);
  });

  it("refuses an unexpected shape or a document type that is not debt", () => {
    expect(publicStatementFrom(null)).toBeNull();
    expect(publicStatementFrom({ ...ANSWER, documents: [{ ...ANSWER.documents[0], type: "receipt" }] })).toBeNull();
    expect(publicStatementFrom({ ...ANSWER, totals: undefined })).toBeNull();
  });

  it("says how late a document is", () => {
    expect(overdueText(0)).toBeNull();
    expect(overdueText(1)).toBe("באיחור של יום אחד");
    expect(overdueText(12)).toBe("באיחור של 12 ימים");
  });
});

describe("sending the statement link (BAL-04)", () => {
  const url = "https://example.test/f/statement/" + "a".repeat(64);

  it("fills the message and leaves out missing parts", () => {
    expect(statementLinkMessage(url, "נגריית הצפון", "דנה")).toBe(`שלום דנה, כאן נגריית הצפון. דף החשבון שלך, עם פירוט החובות הפתוחים, נמצא בקישור הזה: ${url}`);
    expect(statementLinkMessage(url, null, null)).toBe(`שלום, דף החשבון שלך, עם פירוט החובות הפתוחים, נמצא בקישור הזה: ${url}`);
  });

  it("opens WhatsApp with an E.164 number only, and mail only to a plain address", () => {
    expect(statementWhatsappHref(url, "עסק", null, "+972501234567")).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/);
    expect(statementWhatsappHref(url, "עסק", null, "050-1234567")).toMatch(/^https:\/\/wa\.me\/\?text=/);
    expect(statementMailtoHref(url, "עסק", null, "dana@example.com")).toMatch(/^mailto:dana@example\.com\?subject=/);
    expect(statementMailtoHref(url, "עסק", null, "a@b.com?bcc=x@y.com")).toMatch(/^mailto:\?subject=/);
  });

  it("the token never reaches a log line", () => {
    expect(redactPublicPath(`/f/statement/${"a".repeat(64)}`)).toBe("/f/statement/[token]");
  });
});

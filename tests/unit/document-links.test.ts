import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DOCUMENT_LINK_TYPES, documentFileName, payStateText, publicDocumentFrom, publicDocumentPath, publicDocumentFilePath } from "@/features/document-links/public";
import { documentLinkLogText, documentLinkMessage, documentMailtoHref, documentWhatsappHref, LINK_PLACEHOLDER } from "@/features/document-links/share";

// DOC-15 (owner (414) א): the customer's document page answer, the share texts and the download's name.

const root = path.resolve(__dirname, "../..");
const migration = readFileSync(path.join(root, "supabase/migrations/20261006021324_document_links.sql"), "utf8");

const full = {
  business: { name: "נגריית הצפון בע\"מ", display_name: "נגריית הצפון" },
  brand: { logo: null, color: "#336699" },
  today: "2026-11-18",
  currency: "ILS",
  document: {
    type: "tax_invoice",
    number: "1001",
    doc_date: "2026-11-01",
    due_date: "2026-11-15",
    amount_agorot: 11700,
    net_agorot: 10000,
    vat_agorot: 1700,
    vat_rate_bp: 1700,
    allocation_number: "123456789",
    pay_state: "partial",
    balance_agorot: 7700,
    overdue_days: 3,
  },
  lines: [{ description: "שירות", quantity: 1.5, unit_price_agorot: 10000, discount_agorot: 0, vat_exempt: false, total_agorot: 15000 }],
  file: true,
  built_with: true,
};

describe("DOC-15 public document", () => {
  it("the link types are the database's closed list", () => {
    const list = /array\[([^\]]+)\]::text\[\]/.exec(migration.slice(migration.indexOf("function app.document_link_types")))?.[1];
    expect(list?.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...DOCUMENT_LINK_TYPES]);
  });

  it("reads a full answer and a cancelled status page; refuses anything else", () => {
    const doc = publicDocumentFrom(full);
    expect(doc).toMatchObject({ kind: "document", title: "חשבונית מס 1001", business: "נגריית הצפון בע\"מ", displayName: "נגריית הצפון", hasFile: true, balanceAgorot: 7700, overdueDays: 3 });
    expect(doc && doc.kind === "document" ? doc.lines[0] : null).toMatchObject({ key: "line-1", quantity: 1.5 });
    const cancelled = publicDocumentFrom({ status_page: { cancelled: true, type: "receipt", number: "7" }, business: { name: "עסק", display_name: "עסק" }, brand: { logo: null, color: null }, built_with: false });
    expect(cancelled).toMatchObject({ kind: "cancelled", title: "קבלה 7" });
    expect(publicDocumentFrom({ ...full, document: { ...full.document, type: "opening_balance" } })).toBeNull();
    expect(publicDocumentFrom({ rate_limited: true })).toBeNull();
    expect(publicDocumentFrom(null)).toBeNull();
  });

  it("says the pay state in words, and nothing for a receipt", () => {
    expect(payStateText({ payState: "partial", overdueDays: 3 })).toBe("שולם חלקית, היתרה באיחור");
    expect(payStateText({ payState: "unpaid", overdueDays: 0 })).toBe("ממתין לתשלום");
    expect(payStateText({ payState: "paid_on_issue", overdueDays: 0 })).toBe("שולם");
    expect(payStateText({ payState: null, overdueDays: 0 })).toBeNull();
  });

  it("names the download by type and number only", () => {
    expect(documentFileName("tax_invoice_receipt", "INV/2026 01")).toBe("חשבונית מס-קבלה INV-2026-01.pdf");
    expect(documentFileName("receipt", "///")).toBe("קבלה מסמך.pdf");
  });

  it("paths", () => {
    expect(publicDocumentPath("t")).toBe("/f/doc/t");
    expect(publicDocumentFilePath("t")).toBe("/api/forms/doc/t/file");
  });
});

describe("DOC-15 share texts", () => {
  const url = "https://mexuzsystem.com/f/doc/" + "a".repeat(64);
  it("the message names the document and carries the link; the timeline copy never holds it", () => {
    const message = documentLinkMessage(url, "חשבונית מס 1001", "נגריית הצפון", "דנה");
    expect(message).toBe(`שלום דנה, כאן נגריית הצפון. חשבונית מס 1001 נמצאת בקישור הזה: ${url}`);
    const logged = documentLinkLogText(url, "חשבונית מס 1001", "נגריית הצפון", "דנה");
    expect(logged).not.toContain("a".repeat(64));
    expect(logged).toContain(LINK_PLACEHOLDER);
    expect(documentLinkMessage(url, "קבלה 7", null, null)).toBe(`שלום, קבלה 7 נמצאת בקישור הזה: ${url}`);
  });

  it("wa.me to an E.164 number only; mailto to a plain address only", () => {
    expect(documentWhatsappHref("x", "+972501234567")).toBe("https://wa.me/972501234567?text=x");
    expect(documentWhatsappHref("x", "050-1234567")).toBe("https://wa.me/?text=x");
    expect(documentMailtoHref(url, "קבלה 7", "עסק", null, "a@b.co").startsWith("mailto:a@b.co?")).toBe(true);
    expect(documentMailtoHref(url, "קבלה 7", "עסק", null, "a@b.co?cc=x@y.z").startsWith("mailto:?")).toBe(true);
  });
});

import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { renderPdf } from "@/features/pdf/render";
import { ACCEPT_WORDING_VERSION, signedOnText } from "@/features/quotes/decision";
import type { QuoteDocumentData } from "@/features/quotes/design-server";
import type { Quote, QuoteLine } from "@/features/quotes/queries";
import {
  checkSignaturePng,
  pngSize,
  quoteSignedPdfDocument,
  readSignature,
  signatureFrom,
  signaturePng,
  signatureSizeOk,
  signedAtText,
  signedPdfBillingFrom,
  signedQuotePdfFileName,
  type QuoteSignature,
} from "@/features/quotes/signed-pdf";

import { pdfText } from "./pdf-text";

// QUO-09 signed PDF (owner, 1 November 2026, answers (3) א and (33) ב): a real file is made and read back: the accepted quote's
// lines (an optional line the customer did not choose says so), the accepted totals, and the signature block: the signer's name,
// the drawn PNG (an image in the file) or the typed name, the date and time in the business's zone, the wording version and the
// decision's fingerprint.

/** A small solid PNG, made here (no file in the repo). */
function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())])));
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]),
  );
}

const LONG =
  "העבודה כוללת תכנון מלא של המערכת, התקנה באתר הלקוח, הדרכה של הצוות במשך שלושה ימי עבודה, ליווי של 30 יום אחרי ההתקנה ותמיכה טלפונית בשעות העבודה. כל שינוי בהיקף העבודה יתומחר בנפרד ויאושר מראש בכתב.";

function line(i: number, extra: Partial<QuoteLine> = {}): QuoteLine {
  return {
    id: `l${i}`,
    position: i,
    kind: "item",
    productId: null,
    name: `שירות ייעוץ מספר ${i} (כולל WiFi 5G)`,
    description: i % 9 === 0 ? LONG : null,
    unitName: "שעה",
    quantity: 2,
    unitPriceAgorot: 123450,
    discountBp: i % 4 === 0 ? 1250 : null,
    discountAgorot: null,
    vatExempt: false,
    billing: i % 10 === 0 ? "monthly" : "one_time",
    isOptional: i === 5,
    optionalSelected: false,
    source: "manual",
    priceListId: null,
    priceListName: null,
    totalAgorot: 246900,
    ...extra,
  };
}

function sample(lineCount: number): QuoteDocumentData {
  const quote: Quote = {
    id: "q1",
    previousId: null,
    cancelledFrom: null,
    cancelReason: null,
    addendumOf: null,
    title: "שדרוג מערכת המחשוב 2026 עבור Acme Ltd.",
    status: "accepted",
    numberDisplay: "Q-1001",
    sentAt: "2026-10-26",
    customerName: null,
    customerContactName: null,
    customerDeletedAt: null,
    bankDetails: { bankName: "בנק לאומי", branch: "800", account: "12345678", accountName: "חברת הדוגמה בע\"מ" },
    dealId: null,
    contactId: null,
    companyId: null,
    ownerId: null,
    quoteDate: "2026-10-26",
    validUntil: "2026-11-25",
    pricesIncludeVat: false,
    noVatReason: null,
    noVatNote: null,
    discountBp: null,
    discountAgorot: null,
    notes: "תודה שבחרתם בנו. לשאלות: 03-5551234 או office@example.co.il.",
    terms: `${LONG}\nתשלום שוטף + 30.`,
    vatRateBp: 1800,
    subtotalAgorot: 12345600,
    discountTotalAgorot: 0,
    netTotalAgorot: 12345600,
    vatAgorot: 2222208,
    totalAgorot: 14567808,
    createdAt: "2026-10-26",
  };
  return {
    design: { headerText: "הצעה זו בתוקף ל-30 יום.", footerText: "חברת הדוגמה בע\"מ · מחויבים לשירות", showLogo: true, showBusinessDetails: true, showBankDetailsQuote: true, showBankDetailsOrder: true, showBankDetailsStatement: true, accentColor: null },
    color: "#ffcc00",
    logoUrl: null,
    business: { name: 'חברת הדוגמה בע"מ', taxId: "512345678", address: "רחוב הרצל 10, תל אביב", phone: "+972-3-555-1234", email: "office@example.co.il" },
    customer: { name: "Acme Ltd.", attention: "ישראל ישראלי", address: "דרך מנחם בגין 1, תל אביב", email: "billing@acme.example", taxId: "516000000" },
    quote,
    lines: [
      { ...line(0), kind: "group", name: "שלב א: תכנון", unitName: null, totalAgorot: 0 },
      ...Array.from({ length: lineCount }, (_, i) => line(i + 1)),
    ],
    schedule: [
      { key: "s1", name: "מקדמה בחתימה", percentBp: 3000, dueDate: null, milestone: "בחתימה", amountAgorot: 4370342 },
      { key: "s2", name: "יתרה", percentBp: 7000, dueDate: "2026-12-01", milestone: null, amountAgorot: 10197466 },
    ],
  };
}

const reverse = (s: string) => [...s].reverse().join("");
const pieces = (bytes: Uint8Array) => pdfText(bytes).flatMap((page) => page.pieces.map((p) => p.text));
const FP = "ab".repeat(32);

function signature(extra: Partial<QuoteSignature> = {}): QuoteSignature {
  return {
    signerName: "נועה לוי",
    kind: "drawn",
    image: png(120, 40, [20, 20, 20]),
    decidedAt: "2026-11-01T22:15:00Z",
    timeZone: "Asia/Jerusalem",
    wordingVersion: ACCEPT_WORDING_VERSION,
    fingerprint: FP,
    ...extra,
  };
}

/** Counts the image objects the file holds. */
const images = (bytes: Uint8Array) => (Buffer.from(bytes).toString("latin1").match(/\/Subtype\s*\/Image/g) ?? []).length;

describe("the signed PDF of an accepted quote, read back from a real file (QUO-09)", () => {
  it("holds the lines as accepted, the accepted totals and the drawn signature with its facts", async () => {
    const bytes = await renderPdf(quoteSignedPdfDocument(sample(5), null, signature()));
    if (process.env.QUO09_PDF_OUT) writeFileSync(process.env.QUO09_PDF_OUT, bytes);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    const text = pieces(bytes);
    const all = text.join("\n");
    // the signature block: its title, the signer, the time in Israel (22:15 UTC on 1 November is 00:15 on the 2nd)
    expect(text).toContain(reverse("אישור הלקוח וחתימתו"));
    expect(all).toContain(reverse("שם החותם: נועה לוי"));
    expect(all).toContain("02.11.2026");
    expect(all).toContain("00:15");
    expect(all).toContain(ACCEPT_WORDING_VERSION);
    expect(all).toContain(FP);
    expect(text).toContain(reverse("אושרה ונחתמה בידי הלקוח"));
    // an optional line the customer did not choose says so
    expect(all).toContain(reverse("רשות, לא נבחרה"));
    // the accepted totals as stored on the quote row
    expect(text.some((p) => /^₪\s145,678\.08$/.test(p))).toBe(true);
    // the drawn signature is an image in the file
    expect(images(bytes)).toBe(1);
    // owner (38) ב: the customer's billing address, email and tax id, like the PDF as sent
    expect(all).toContain("billing@acme.example");
    expect(all).toContain("516000000");
    expect(all).toContain(reverse("מספר מזהה:"));
    expect(all).toContain(reverse("דרך מנחם בגין 1, תל אביב"));
    expect(all).not.toContain("�");
  });

  it("owner (38) ב: reads the customer route's billing block field by field, and prints only what it holds", async () => {
    expect(signedPdfBillingFrom({ address: "רחוב א 1", email: "a@b.co", tax_id: "516000000" })).toEqual({ address: "רחוב א 1", email: "a@b.co", taxId: "516000000" });
    expect(signedPdfBillingFrom({ address: null, email: 5, tax_id: "" })).toEqual({ address: null, email: null, taxId: null });
    expect(signedPdfBillingFrom(undefined)).toEqual({ address: null, email: null, taxId: null });
    expect(signedPdfBillingFrom(["x"])).toEqual({ address: null, email: null, taxId: null });
    const data = sample(1);
    const none = { ...data, customer: data.customer ? { ...data.customer, address: null, email: null, taxId: null } : null };
    const all = pieces(await renderPdf(quoteSignedPdfDocument(none, null, signature()))).join("\n");
    expect(all).toContain("Acme Ltd.");
    expect(all).not.toContain("billing@acme.example");
    expect(all).not.toContain(reverse("מספר מזהה:"));
  });

  it("a typed signature prints the name in the signature box and no image", async () => {
    const bytes = await renderPdf(quoteSignedPdfDocument(sample(1), null, signature({ kind: "typed", image: null })));
    if (process.env.QUO09_TYPED_OUT) writeFileSync(process.env.QUO09_TYPED_OUT, bytes);
    expect(images(bytes)).toBe(0);
    const text = pieces(bytes);
    // the typed name itself, besides the "שם החותם" line
    expect(text.filter((p) => p === reverse("נועה לוי")).length).toBeGreaterThanOrEqual(1);
  });

  it("reads the database's signature block and refuses another shape", () => {
    const dataUrl = `data:image/png;base64,${Buffer.from(png(4, 2, [0, 0, 0])).toString("base64")}`;
    const raw = { signer_name: "נועה לוי", kind: "drawn", image: dataUrl, decided_at: "2026-11-01T10:00:00+00:00", time_zone: "Asia/Jerusalem", wording_version: "draft-2026-10-18", fingerprint: FP };
    const parsed = signatureFrom(raw);
    expect(parsed?.signerName).toBe("נועה לוי");
    expect(parsed?.image?.[0]).toBe(0x89);
    expect(signatureFrom({ ...raw, kind: "typed", image: null })?.image).toBeNull();
    expect(signatureFrom({ ...raw, image: null })).toBeNull();
    expect(signatureFrom({ ...raw, image: "data:image/png;base64,AAAA" })).toBeNull();
    expect(signatureFrom({ ...raw, fingerprint: "x" })).toBeNull();
    expect(signatureFrom(null)).toBeNull();
    expect(signaturePng("data:image/jpeg;base64,AAAA")).toBeNull();
    expect(signedAtText("2026-06-30T21:30:00Z", "Asia/Jerusalem")).toBe("01.07.2026 בשעה 00:30");
    expect(signedQuotePdfFileName("Q-1001", "x")).toBe("הצעת מחיר Q-1001 - חתומה.pdf");
    // owner (37) ב: the staff line, the day in the business's zone (21:30 UTC on 30 June is 1 July in Israel)
    expect(signedOnText("2026-06-30T21:30:00Z", "Asia/Jerusalem")).toBe("נחתמה ב-01.07.2026");
    expect(signedOnText("2026-06-30T21:30:00Z", "UTC")).toBe("נחתמה ב-30.06.2026");
  });

  it("review (medium): refuses a PNG whose header declares a huge image (a PNG bomb) before the renderer sees it", () => {
    // a real small PNG, then the same file with its header saying 100,000 x 100,000 pixels (the CRC is not checked here)
    const real = png(4, 2, [0, 0, 0]);
    expect(pngSize(real)).toEqual({ width: 4, height: 2 });
    const bomb = new Uint8Array(real);
    const view = new DataView(bomb.buffer);
    view.setUint32(16, 100_000);
    view.setUint32(20, 100_000);
    expect(pngSize(bomb)).toEqual({ width: 100_000, height: 100_000 });
    const url = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    expect(signaturePng(url(real))).not.toBeNull();
    expect(signaturePng(url(bomb))).toBeNull();
    expect(signatureFrom({ signer_name: "נועה", kind: "drawn", image: url(bomb), decided_at: "2026-11-01T10:00:00Z", time_zone: "UTC", wording_version: "v", fingerprint: FP })).toBeNull();
    // the limits: a pad 4 times the device pixel ratio fits; too wide, too tall, too many pixels, zero do not
    expect(signatureSizeOk({ width: 2400, height: 640 })).toBe(true);
    expect(signatureSizeOk({ width: 4001, height: 10 })).toBe(false);
    expect(signatureSizeOk({ width: 10, height: 2001 })).toBe(false);
    expect(signatureSizeOk({ width: 4000, height: 2000 })).toBe(false);
    expect(signatureSizeOk({ width: 0, height: 10 })).toBe(false);
    expect(signatureSizeOk(null)).toBe(false);
    expect(pngSize(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("review: the IHDR is 13 bytes long, and the image data never inflates past what the header allows", () => {
    const url = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;
    // a 1 x 1 PNG whose image data is 10 MB of zeros, compressed to a few kilobytes
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 6;
    const chunk = (type: string, data: Buffer, length = data.length) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const big = deflateSync(Buffer.alloc(10_000_000));
    expect(big.length).toBeLessThan(50_000);
    const bomb = new Uint8Array(Buffer.concat([magic, chunk("IHDR", header), chunk("IDAT", big), chunk("IEND", Buffer.alloc(0))]));
    expect(pngSize(bomb)).toEqual({ width: 1, height: 1 });
    expect(checkSignaturePng(url(bomb))).toEqual({ problem: "data" });
    expect(signaturePng(url(bomb))).toBeNull();
    const block = { signer_name: "נועה", kind: "drawn", image: url(bomb), decided_at: "2026-11-01T10:00:00Z", time_zone: "UTC", wording_version: "v", fingerprint: FP };
    expect(readSignature(block)).toEqual({ problem: "data" });
    // the same PNG with its real 1 x 1 pixel passes
    const pixel = new Uint8Array(Buffer.concat([magic, chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4]))), chunk("IEND", Buffer.alloc(0))]));
    expect("bytes" in checkSignaturePng(url(pixel))).toBe(true);
    expect("signature" in readSignature({ ...block, image: url(pixel) })).toBe(true);
    // an IHDR whose length field is not 13, data that does not inflate, and no image data are refused
    const longHeader = new Uint8Array(Buffer.concat([magic, chunk("IHDR", Buffer.concat([header, Buffer.alloc(1)])), chunk("IDAT", deflateSync(Buffer.from([0, 1, 2, 3, 4]))), chunk("IEND", Buffer.alloc(0))]));
    expect(checkSignaturePng(url(longHeader))).toEqual({ problem: "header" });
    const garbage = new Uint8Array(Buffer.concat([magic, chunk("IHDR", header), chunk("IDAT", Buffer.from("not zlib")), chunk("IEND", Buffer.alloc(0))]));
    expect(checkSignaturePng(url(garbage))).toEqual({ problem: "data" });
    const noData = new Uint8Array(Buffer.concat([magic, chunk("IHDR", header), chunk("IEND", Buffer.alloc(0))]));
    expect(checkSignaturePng(url(noData))).toEqual({ problem: "data" });
    expect(readSignature({ ...block, decided_at: "x" })).toEqual({ problem: "shape" });
  });
});

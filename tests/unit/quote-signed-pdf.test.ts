import { writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { renderPdf } from "@/features/pdf/render";
import { ACCEPT_WORDING_VERSION } from "@/features/quotes/decision";
import type { QuoteDocumentData } from "@/features/quotes/design-server";
import type { Quote, QuoteLine } from "@/features/quotes/queries";
import { quoteSignedPdfDocument, signatureFrom, signaturePng, signedAtText, signedQuotePdfFileName, type QuoteSignature } from "@/features/quotes/signed-pdf";

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
    // the customer's billing details are not on it (the names as sent only)
    expect(all).not.toContain("billing@acme.example");
    expect(all).not.toContain("�");
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
  });
});

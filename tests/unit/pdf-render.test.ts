import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { logoKind } from "@/features/pdf/logo";
import { PDF_COLORS, renderPdf } from "@/features/pdf/render";
import type { QuoteDocumentData } from "@/features/quotes/design-server";
import { quotePdfDocument, quotePdfFileName, remadeNote } from "@/features/quotes/pdf";
import type { Quote, QuoteLine } from "@/features/quotes/queries";

import { pdfText } from "./pdf-text";

// QUO-06 (owner, 13 October 2026): before the PDF counts as built, a real file is made and read back: long Hebrew text,
// Hebrew with English and numbers on one line, amounts with ₪ and percentages, a phone and an email, a table of more
// than one page and a logo. The text is read from the file itself (tests/unit/pdf-text.ts reads the fonts' ToUnicode
// maps and the page operators): every line is drawn left to right in visual order, so the expected strings are visual.

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
    status: "sent",
    numberDisplay: "Q-1001",
    sentAt: "2026-10-26",
    customerName: null,
    customerContactName: null,
    customerDeletedAt: null,
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
    design: { headerText: "הצעה זו בתוקף ל-30 יום.", footerText: "חברת הדוגמה בע\"מ · מחויבים לשירות", showLogo: true, showBusinessDetails: true, accentColor: null },
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

const allLines = (pages: ReturnType<typeof pdfText>) => pages.flatMap((page) => page.lines);
const allPieces = (pages: ReturnType<typeof pdfText>) => pages.flatMap((page) => page.pieces.map((p) => p.text));

describe("the quote PDF, read back from a real file (QUO-06)", () => {
  it("is a real PDF with Hebrew in visual order, numbers, phone and email left to right, and a long table on several pages", async () => {
    const logo = png(60, 20, [30, 86, 214]);
    expect(logoKind(logo)).toBe("png");
    const bytes = await renderPdf(quotePdfDocument(sample(70), { data: logo, kind: "png" }));
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
    if (process.env.QUO06_PDF_OUT) writeFileSync(process.env.QUO06_PDF_OUT, bytes);

    const pages = pdfText(bytes);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    const lines = allLines(pages);
    const pieces = allPieces(pages);

    // the letterhead: the business's details, the phone and the email as typed
    expect(pieces).toContain('מ"עב המגודה תרבח');
    expect(pieces).toContain("+972-3-555-1234");
    expect(pieces).toContain("office@example.co.il");
    expect(pieces).toContain("512345678 :.פ.ח וא קסוע רפסמ");
    expect(pieces).toContain("Q-1001 :רפסמ");
    expect(pieces).toContain("ריחמ תעצה");
    // Hebrew with English and a number in one line
    // (the full stop at the end of a right-to-left paragraph goes to its left end, as in the browser)
    expect(pieces).toContain(".Acme Ltd רובע 2026 בושחמה תכרעמ גורדש");
    expect(pieces).toContain("(WiFi 5G ללוכ) 1 רפסמ ץועיי תוריש");
    // amounts with ₪ and percentages, left to right
    expect(pieces).toContain("₪ 1,234.50");
    expect(pieces).toContain("12.5%");
    expect(pieces).toContain("₪ 145,678.08");
    expect(pieces).toContain("18% מ\"עמ");
    // the table's header on every page the table is on: the description column's title
    const tablePages = pages.filter((page) => page.pieces.some((p) => /^ץועיי תוריש|^\(WiFi/.test(p.text) || p.text.includes("ץועיי תוריש")));
    expect(tablePages.length).toBeGreaterThanOrEqual(2);
    for (const page of tablePages) expect(page.pieces.map((p) => p.text)).toContain("רואית");
    // the long Hebrew description wraps over several lines, each in visual order
    const wrapped = pieces.filter((p) => p.includes("תכרעמה לש אלמ ןונכת"));
    expect(wrapped.length).toBeGreaterThan(0);
    // the payment schedule, the notes and the terms
    expect(pieces).toContain("םימולשת חול");
    expect(pieces).toContain("30%");
    // a phone and an email typed into Hebrew text keep their own order
    expect(lines.some((l) => l.includes(".office@example.co.il וא 03-5551234 :תולאשל"))).toBe(true);
    // every page says which page it is
    pages.forEach((page, i) => expect(page.pieces.map((p) => p.text)).toContain(`${pages.length} ךותמ ${i + 1} דומע`));
    // no character the font could not map
    expect(lines.join("\n")).not.toContain("�");
  });

  it("an empty quote and a quote without logo or business details still make a valid file", async () => {
    const data = sample(0);
    data.lines = [];
    data.schedule = [];
    data.design = { ...data.design, showBusinessDetails: false, headerText: null, footerText: null };
    const pages = pdfText(await renderPdf(quotePdfDocument(data, null)));
    expect(pages).toHaveLength(1);
    const pieces = allPieces(pages);
    expect(pieces).toContain(".העצהב תורוש ןיא");
    // without a logo or details the business's name is still on it
    expect(pieces).toContain('מ"עב המגודה תרבח');
  });

  it("only a remade file carries the line 'נוצר מחדש ב-…', dated in the business's zone (owner, 26 October 2026)", async () => {
    // 22:30 UTC on 26 October 2026 is already the 27th in Israel
    const note = remadeNote(new Date("2026-10-26T22:30:00Z"), "Asia/Jerusalem");
    expect(note).toBe("נוצר מחדש ב-27.10.2026 מהנתונים השמורים");
    expect(remadeNote(new Date("2026-10-26T22:30:00Z"), "UTC")).toBe("נוצר מחדש ב-26.10.2026 מהנתונים השמורים");
    expect(quotePdfDocument(sample(3), null).footerNote).toBeNull();
    expect(quotePdfDocument(sample(3), null, { remadeNote: note }).footerNote).toBe(note);
    const first = allPieces(pdfText(await renderPdf(quotePdfDocument(sample(3), null)))).join(" ");
    const remade = allPieces(pdfText(await renderPdf(quotePdfDocument(sample(3), null, { remadeNote: note })))).join(" ");
    expect(first).not.toContain("27.10.2026");
    expect(remade).toContain("27.10.2026");
    expect(remade).toContain("םירומשה");
    expect(first).not.toContain("םירומשה");
  });

  it("names the file after the quote's number", () => {
    expect(quotePdfFileName("Q-1001", "x")).toBe("הצעת מחיר Q-1001.pdf");
    expect(quotePdfFileName(null, 'שדרוג "מערכת" / 2026')).toBe("הצעת מחיר - שדרוג מערכת 2026.pdf");
  });

  it("reads the logo's kind from its bytes; WebP and anything else are left out", () => {
    expect(logoKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(logoKind(new TextEncoder().encode("RIFF0000WEBPVP8 "))).toBeNull();
    expect(logoKind(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });

  it("uses the light theme's ink and line colours", () => {
    const css = readFileSync(new URL("../../src/app/globals.css", import.meta.url), "utf8");
    const base = (name: string) => new RegExp(`${name}:\\s*(#[0-9a-f]{6});`).exec(css)?.[1];
    const role = (name: string) => base(new RegExp(`--color-${name}:\\s*var\\((--[\\w-]+)\\)`).exec(css)?.[1] ?? "");
    expect(PDF_COLORS).toEqual({ ink: role("ink"), inkSoft: role("ink-soft"), line: role("line"), lineStrong: role("line-strong") });
  });

  it("poppler reads the same file as Hebrew in logical order (when pdftotext is on the machine)", async () => {
    let has = true;
    try {
      execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    } catch {
      has = false;
    }
    if (!has) return;
    const dir = mkdtempSync(join(tmpdir(), "quo06-"));
    try {
      const file = join(dir, "q.pdf");
      writeFileSync(file, await renderPdf(quotePdfDocument(sample(5), null)));
      const text = execFileSync("pdftotext", ["-enc", "UTF-8", file, "-"]).toString("utf8").replace(/[‪-‮‎‏]/g, "");
      expect(text).toContain("הצעת מחיר");
      expect(text).toContain("סה\"כ לתשלום");
      expect(text).toContain("+972-3-555-1234");
      expect(text).toContain("1,234.50");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

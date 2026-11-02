// QUO-09 signed PDF (owner, 1 November 2026, answers (3) א and (33) ב): after the customer accepts a quote on its page, the
// server keeps a new PDF of the accepted quote: the lines as accepted (optional lines as chosen), the accepted totals of the
// quote row, the signer's name, the drawn signature or the typed name, the date and time in the business's zone, the wording
// version and the fingerprint of the decision. Server-side (node:zlib), no I/O: the document is built here from the quote's document data
// (src/features/quotes/pdf.ts) plus a signature block, so it is unit tested.

import { inflateSync } from "node:zlib";

import { z } from "zod";

import { ltr, type PdfDocument, type PdfLine, type PdfLogo } from "@/features/pdf/document";

import { ACCEPT_WORDING, ACCEPT_WORDING_VERSION, SIGNATURE_IMAGE, SIGNATURE_IMAGE_MAX } from "./decision";
import type { QuoteDocumentData } from "./design-server";
import { quotePdfDocument, quotePdfFileName } from "./pdf";

/** The decision's signature block, as public.quote_signed_pdf_public / quote_signed_pdf_allowed answer it. */
export type QuoteSignature = {
  signerName: string;
  kind: "drawn" | "typed";
  // the drawn signature's PNG bytes (null for a typed one)
  image: Uint8Array | null;
  decidedAt: string;
  timeZone: string;
  wordingVersion: string;
  // quote_decisions.choice_sha256, else content_sha256: the store checks it again
  fingerprint: string;
};

const blockSchema = z.object({
  signer_name: z.string().min(1).max(200),
  kind: z.enum(["drawn", "typed"]),
  image: z.string().max(SIGNATURE_IMAGE_MAX).regex(SIGNATURE_IMAGE).nullable().optional(),
  decided_at: z.string().min(1),
  time_zone: z.string().min(1).max(64),
  wording_version: z.string().min(1).max(40),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Review (medium): a small file may declare a huge image (a "PNG bomb") that the PDF renderer would inflate. A signature
// drawn on the page's pad (160 CSS pixels high, the device's pixel ratio up to 4) stays far below these.
export const SIGNATURE_MAX_WIDTH = 4000;
export const SIGNATURE_MAX_HEIGHT = 2000;
export const SIGNATURE_MAX_PIXELS = 4_000_000;

/** The width and height a PNG's header (IHDR, always the first chunk, 13 bytes long) declares, or null when it has none. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 33 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]) !== "IHDR") return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** True when a PNG header declares a size a signature may have. */
export function signatureSizeOk(size: { width: number; height: number } | null): boolean {
  return (
    size !== null &&
    size.width >= 1 &&
    size.height >= 1 &&
    size.width <= SIGNATURE_MAX_WIDTH &&
    size.height <= SIGNATURE_MAX_HEIGHT &&
    size.width * size.height <= SIGNATURE_MAX_PIXELS
  );
}

/** Why a signature image is refused: not a PNG data URL, no proper header, a size no signature has, image data that inflates
 * past what the header allows (or does not inflate). */
export type SignatureProblem = "format" | "header" | "size" | "data";

/** The image data (every IDAT chunk, in order) of a PNG whose chunks are well formed, or null. */
function idatData(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let at = PNG_MAGIC.length;
  for (let chunks = 0; at + 12 <= bytes.length && chunks < 10_000; chunks++) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const end = at + 12 + length;
    if (end > bytes.length) return null;
    if (type === "IDAT") parts.push(bytes.subarray(at + 8, at + 8 + length));
    if (type === "IEND") return parts.length > 0 ? Buffer.concat(parts) : null;
    at = end;
  }
  return null;
}

/**
 * Review: the checks a drawn signature passes before the PDF renderer sees it. The header must be a real IHDR (length 13) of a
 * signature's size, and the image data must inflate to no more than the header allows for 8-bit RGBA rows
 * (height x (1 + width x 4)), so a small file cannot unpack into a huge one.
 */
export function checkSignaturePng(dataUrl: string): { bytes: Uint8Array } | { problem: SignatureProblem } {
  if (!SIGNATURE_IMAGE.test(dataUrl)) return { problem: "format" };
  const bytes = new Uint8Array(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
  const size = pngSize(bytes);
  if (!size) return { problem: "header" };
  if (!signatureSizeOk(size)) return { problem: "size" };
  const data = idatData(bytes);
  if (!data) return { problem: "data" };
  try {
    inflateSync(data, { maxOutputLength: size.height * (1 + size.width * 4) + 1024 });
  } catch {
    return { problem: "data" };
  }
  return { bytes };
}

/** The bytes of a `data:image/png;base64,…` signature, or null when it fails checkSignaturePng. */
export function signaturePng(dataUrl: string): Uint8Array | null {
  const checked = checkSignaturePng(dataUrl);
  return "bytes" in checked ? checked.bytes : null;
}

/**
 * The answer's signature block, or why it cannot be used: "shape" (not the expected answer) or the drawn image's problem.
 */
export function readSignature(raw: unknown): { signature: QuoteSignature } | { problem: "shape" | SignatureProblem } {
  const parsed = blockSchema.safeParse(raw);
  if (!parsed.success) return { problem: "shape" };
  const b = parsed.data;
  if (Number.isNaN(Date.parse(b.decided_at))) return { problem: "shape" };
  let image: Uint8Array | null = null;
  if (b.kind === "drawn") {
    if (!b.image) return { problem: "format" };
    const checked = checkSignaturePng(b.image);
    if ("problem" in checked) return checked;
    image = checked.bytes;
  }
  return {
    signature: { signerName: b.signer_name, kind: b.kind, image, decidedAt: b.decided_at, timeZone: b.time_zone, wordingVersion: b.wording_version, fingerprint: b.fingerprint },
  };
}

/** The answer's signature block, or null when it cannot be used. */
export function signatureFrom(raw: unknown): QuoteSignature | null {
  const read = readSignature(raw);
  return "signature" in read ? read.signature : null;
}

/** What staff read when the stored decision's signature cannot be put on a PDF. */
export const SIGNATURE_INVALID_MESSAGE = "החתימה השמורה אינה תקינה, לא ניתן ליצור PDF חתום.";

/** "DD.MM.YYYY בשעה HH:MM" in the business's zone. */
export function signedAtText(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("day")}.${part("month")}.${part("year")} בשעה ${part("hour")}:${part("minute")}`;
}

/** The signed PDF's file name: the quote's own, marked signed. */
export function signedQuotePdfFileName(numberDisplay: string | null, title: string): string {
  return quotePdfFileName(numberDisplay, title).replace(/\.pdf$/, " - חתומה.pdf");
}


/**
 * The signed document: the quote as accepted (its stored totals are the accepted ones since QUO-08), the customer named as
 * printed when it was sent, and the signature block at the end.
 */
export function quoteSignedPdfDocument(data: QuoteDocumentData, logo: PdfLogo | null, signature: QuoteSignature): PdfDocument {
  // the customer as printed on the quote when it was sent (QUO-07); both routes render the same document
  const customer = data.customer ? { ...data.customer, address: null, email: null, taxId: null } : null;
  const base = quotePdfDocument({ ...data, customer }, logo, { accepted: true });
  const when = signedAtText(signature.decidedAt, signature.timeZone);
  const wording =
    signature.wordingVersion === ACCEPT_WORDING_VERSION
      ? `נוסח האישור (גרסה ${ltr(signature.wordingVersion)}): ${ACCEPT_WORDING}`
      : `גרסת נוסח האישור: ${ltr(signature.wordingVersion)}`;
  const facts: PdfLine[] = [
    { text: `שם החותם: ${signature.signerName}`, bold: true },
    { text: `נחתם ב-${when}` },
    { text: wording, muted: true, size: 8.5 },
    { text: `טביעת האצבע של האישור, SHA-256: ${ltr(signature.fingerprint)}`, muted: true, size: 7.5 },
  ];
  const number = data.quote.numberDisplay;
  return {
    ...base,
    title: `${base.title} (חתומה)`,
    meta: [...base.meta, { text: "אושרה ונחתמה בידי הלקוח", bold: true, accent: true }],
    blocks: [
      ...base.blocks,
      {
        kind: "signature",
        title: "אישור הלקוח וחתימתו",
        image: signature.image ? { data: signature.image, kind: "png" } : null,
        typedName: signature.kind === "typed" ? signature.signerName : null,
        lines: facts,
      },
    ],
    pageNote: number ? `הצעת מחיר ${ltr(number)}, חתומה` : "הצעת מחיר חתומה",
  };
}

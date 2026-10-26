import { createHash } from "node:crypto";

// QUO-06 follow-ups (owner, 26 October 2026, answers (1) and (3)): a quote's PDF is written by the server only, with the
// SHA-256 of its bytes kept on its files row; every serving (the staff download and the customer's link) reads the bytes,
// compares them with that fingerprint and refuses on a mismatch. Pure helpers, shared by both routes and the writer.

const HEX64 = /^[0-9a-f]{64}$/;

/** The hex SHA-256 of the bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True only when the bytes are exactly the file that was stored (a missing or malformed fingerprint never matches). */
export function matchesFingerprint(bytes: Uint8Array, expected: string | null | undefined): boolean {
  if (!expected || !HEX64.test(expected)) return false;
  return sha256Hex(bytes) === expected;
}

/** The path public.quote_pdf_store / quote_public_pdf answer: `<org>/<file id>` of that business, nothing else. */
export function isQuotePdfPath(path: unknown, orgId?: string): path is string {
  if (typeof path !== "string") return false;
  const match = /^([0-9a-f-]{36})\/([0-9a-f-]{36})$/.exec(path);
  if (!match) return false;
  return orgId === undefined || match[1] === orgId;
}

/** RFC 5987 value-chars: encodeURIComponent leaves ' ( ) * ! unescaped, which attr-char does not allow. */
export function rfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A Content-Disposition with an ASCII fallback and the real (Hebrew) name in filename*. */
export function contentDisposition(name: string, inline = false): string {
  const clean = name.replace(/[\r\n"\\/]/g, "").trim() || "quote.pdf";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${rfc5987(clean)}`;
}

/** The headers of a served PDF: never cached anywhere, never sniffed; opened in the browser only inside a sandbox. */
export function pdfHeaders(name: string, size: number, inline = false): Record<string, string> {
  return {
    "Content-Type": "application/pdf",
    "Content-Length": String(size),
    "Content-Disposition": contentDisposition(name, inline),
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...(inline ? { "Content-Security-Policy": "sandbox" } : {}),
  };
}

/** What staff see when a stored quote PDF no longer matches its fingerprint (never replaced automatically). */
export const DAMAGED_PDF_MESSAGE = "קובץ ה-PDF של ההצעה פגום ולכן לא נפתח. פנו לתמיכה";

export type StoreAnswer = { status: "upload"; path: string } | { status: "stored"; fileId: string } | { status: "busy" };

/** The answer of public.quote_pdf_store, or null when it has another shape. */
export function storeAnswerFrom(raw: unknown, orgId: string): StoreAnswer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { status?: unknown; path?: unknown; file_id?: unknown };
  if (r.status === "busy") return { status: "busy" };
  if (r.status === "upload" && isQuotePdfPath(r.path, orgId)) return { status: "upload", path: r.path };
  if (r.status === "stored" && typeof r.file_id === "string" && /^[0-9a-f-]{36}$/.test(r.file_id)) return { status: "stored", fileId: r.file_id };
  return null;
}

export type PublicPdfAnswer = { kind: "file"; path: string; sha256: string; name: string } | { kind: "unavailable" } | { kind: "rate-limited" };

/** The answer of public.quote_public_pdf, or null when it has another shape. */
export function publicPdfAnswerFrom(raw: unknown): PublicPdfAnswer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { path?: unknown; sha256?: unknown; name?: unknown; unavailable?: unknown; rate_limited?: unknown };
  if (r.rate_limited === true) return { kind: "rate-limited" };
  if (r.unavailable === true) return { kind: "unavailable" };
  if (isQuotePdfPath(r.path) && typeof r.sha256 === "string" && HEX64.test(r.sha256) && typeof r.name === "string" && r.name.length > 0) {
    return { kind: "file", path: r.path, sha256: r.sha256, name: r.name };
  }
  return null;
}

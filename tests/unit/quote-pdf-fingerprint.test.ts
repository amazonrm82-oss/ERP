import { describe, expect, it } from "vitest";

import {
  contentDisposition,
  isQuotePdfPath,
  matchesFingerprint,
  pdfHeaders,
  publicPdfAnswerFrom,
  sha256Hex,
  storeAnswerFrom,
} from "@/features/quotes/pdf-fingerprint";

const ORG = "11111111-1111-4111-8111-111111111111";
const FILE = "22222222-2222-4222-8222-222222222222";
const bytes = new TextEncoder().encode("%PDF-1.7 test");

describe("quote PDF fingerprint (QUO-06 follow-ups)", () => {
  it("matches only the exact bytes", () => {
    const sha = sha256Hex(bytes);
    expect(sha).toMatch(/^[0-9a-f]{64}$/);
    expect(matchesFingerprint(bytes, sha)).toBe(true);
    expect(matchesFingerprint(new TextEncoder().encode("%PDF-1.7 tesT"), sha)).toBe(false);
    expect(matchesFingerprint(bytes, null)).toBe(false);
    expect(matchesFingerprint(bytes, sha.toUpperCase())).toBe(false);
    expect(matchesFingerprint(bytes, "")).toBe(false);
  });

  it("accepts only a path of the business: <org>/<file id>", () => {
    expect(isQuotePdfPath(`${ORG}/${FILE}`, ORG)).toBe(true);
    expect(isQuotePdfPath(`${FILE}/${FILE}`, ORG)).toBe(false);
    expect(isQuotePdfPath(`${ORG}/../${FILE}`, ORG)).toBe(false);
    expect(isQuotePdfPath(`${ORG}/${FILE}/x`)).toBe(false);
    expect(isQuotePdfPath(42)).toBe(false);
  });

  it("reads the write function's answers", () => {
    expect(storeAnswerFrom({ status: "upload", path: `${ORG}/${FILE}` }, ORG)).toEqual({ status: "upload", path: `${ORG}/${FILE}` });
    expect(storeAnswerFrom({ status: "upload", path: `other/${FILE}` }, ORG)).toBeNull();
    expect(storeAnswerFrom({ status: "stored", file_id: FILE }, ORG)).toEqual({ status: "stored", fileId: FILE });
    expect(storeAnswerFrom({ status: "busy" }, ORG)).toEqual({ status: "busy" });
    expect(storeAnswerFrom(null, ORG)).toBeNull();
    expect(storeAnswerFrom({ status: "nope" }, ORG)).toBeNull();
  });

  it("reads the public function's answers", () => {
    const sha = sha256Hex(bytes);
    expect(publicPdfAnswerFrom({ path: `${ORG}/${FILE}`, sha256: sha, name: "הצעה.pdf" })).toEqual({ kind: "file", path: `${ORG}/${FILE}`, sha256: sha, name: "הצעה.pdf" });
    expect(publicPdfAnswerFrom({ unavailable: true })).toEqual({ kind: "unavailable" });
    expect(publicPdfAnswerFrom({ rate_limited: true })).toEqual({ kind: "rate-limited" });
    expect(publicPdfAnswerFrom({ path: `${ORG}/${FILE}`, sha256: "x", name: "a.pdf" })).toBeNull();
    expect(publicPdfAnswerFrom([])).toBeNull();
  });

  it("names the download safely, in Hebrew too, and never caches it", () => {
    const value = contentDisposition('הצעת מחיר 12"\r\n.pdf');
    expect(value.startsWith("attachment; ")).toBe(true);
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent("הצעת מחיר 12.pdf")}`);
    expect(contentDisposition("a.pdf", true).startsWith("inline; ")).toBe(true);
    // RFC 5987: an apostrophe (and ( ) * !) is percent-encoded in filename*, so the value cannot end early
    const apostrophe = contentDisposition("הצעה של דנה'ס (1)*!.pdf");
    const star = apostrophe.split("filename*=UTF-8''")[1];
    expect(star).not.toMatch(/['()*!]/);
    expect(star).toContain("%27");
    expect(star).toContain("%28");
    expect(decodeURIComponent(star)).toBe("הצעה של דנה'ס (1)*!.pdf");
    expect(pdfHeaders("a.pdf", 10, true)["Content-Security-Policy"]).toBe("sandbox");
    expect(pdfHeaders("a.pdf", 10)["Content-Security-Policy"]).toBeUndefined();
    const headers = pdfHeaders("a.pdf", 10);
    expect(headers["Cache-Control"]).toContain("no-store");
    expect(headers["Content-Type"]).toBe("application/pdf");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { renderPdf } from "@/features/pdf/render";
import { bodyBlocks, readSignedDocumentSource, signedDocumentPdf } from "@/features/signatures/pdf";
import { publicSignatureFrom, signatureDateText, SIGN_WORDING, SIGN_WORDING_VERSION, signBodySchema, statusSignatureFrom } from "@/features/signatures/public";
import { awaitsSignature, shownSignatureState, signatureLinkMessage, signatureWhatsappHref } from "@/features/signatures/states";

const MIGRATION = readFileSync(join(__dirname, "../../supabase/migrations/20261006021212_signature_documents.sql"), "utf8");

const source = (extra: Record<string, unknown> = {}) => ({
  document: { title: "הסכם שירות", body: "**הסכם שירות**\n\nנערך בין העסק לבין דנה כהן.\n- סעיף ראשון\n1. סעיף ממוספר" },
  business: { name: "העסק בע\"מ", tax_id: "515555555", phone: "03-5550000", email: "office@example.test" },
  brand: { logo: null, color: null },
  signature: {
    signer_name: "דנה כהן",
    id_number: null,
    kind: "typed",
    image: null,
    signed_at: "2026-11-10T08:30:00Z",
    time_zone: "Asia/Jerusalem",
    wording_version: SIGN_WORDING_VERSION,
    wording: SIGN_WORDING,
    fingerprint: "a".repeat(64),
  },
  ...extra,
});

describe("SGN-02: documents for signature", () => {
  it("prints the document's text as paragraphs, a whole bold line bold, lists marked", () => {
    const blocks = bodyBlocks("**כותרת**\n\nשורה עם **מודגש** ו-[קישור](https://example.test)\n- פריט\n3. שלישי");
    expect(blocks).toEqual([
      { kind: "paragraph", text: "כותרת", bold: true },
      expect.objectContaining({ kind: "paragraph", text: expect.stringContaining("שורה עם מודגש ו-קישור (") }),
      { kind: "paragraph", text: "• פריט" },
      { kind: "paragraph", text: "3. שלישי" },
    ]);
  });

  it("reads the database's source and refuses another shape", () => {
    const read = readSignedDocumentSource(source());
    expect("source" in read && read.source.signature.signerName).toBe("דנה כהן");
    expect(readSignedDocumentSource({ ...source(), signature: { kind: "drawn" } })).toEqual({ problem: "shape" });
    const drawnWithout = source();
    (drawnWithout.signature as Record<string, unknown>).kind = "drawn";
    expect(readSignedDocumentSource(drawnWithout)).toEqual({ problem: "format" });
  });

  it("renders a real PDF with the signature block and the wording version", async () => {
    const read = readSignedDocumentSource(source());
    if (!("source" in read)) throw new Error("source");
    const doc = signedDocumentPdf(read.source, null);
    const last = doc.blocks[doc.blocks.length - 1];
    expect(last).toMatchObject({ kind: "signature", typedName: "דנה כהן" });
    expect(JSON.stringify(doc)).toContain(SIGN_WORDING_VERSION);
    expect(JSON.stringify(doc)).toContain(SIGN_WORDING);
    // the stored text is printed, not today's constant
    const other = readSignedDocumentSource(source({ signature: { ...source().signature, wording: "נוסח אחר שנשמר" } }));
    if (!("source" in other)) throw new Error("source");
    expect(JSON.stringify(signedDocumentPdf(other.source, null))).toContain("נוסח אחר שנשמר");
    expect(JSON.stringify(signedDocumentPdf(other.source, null))).not.toContain(SIGN_WORDING);
    const bytes = await renderPdf(doc);
    expect(Buffer.from(bytes.subarray(0, 5)).toString("latin1")).toBe("%PDF-");
  });

  it("shapes the page's answers and refuses anything else", () => {
    const page = publicSignatureFrom({
      document: { title: "חוזה", body: "טקסט", status: "viewed", sent_at: "2026-11-10T08:00:00Z", signed_at: null, expires_at: null },
      business: { name: "עסק", phone: null },
      brand: { logo: null, color: null },
      built_with: true,
      fingerprint: "b".repeat(64),
    });
    expect(page).toMatchObject({ title: "חוזה", status: "viewed", fingerprint: "b".repeat(64) });
    expect(publicSignatureFrom({ document: {} })).toBeNull();
    expect(statusSignatureFrom({ status_page: { state: "cancelled", title: "חוזה", business: "עסק", logo: null, color: null, phone: null } })).toMatchObject({ state: "cancelled" });
    expect(statusSignatureFrom({ status_page: { state: "signed" } })).toBeNull();
  });

  it("the posted signature needs the box, a name and a PNG for a drawn one", () => {
    const base = { fingerprint: "c".repeat(64), signerName: "דנה כהן", idNumber: null, signatureKind: "typed", signatureImage: null, agreed: true };
    expect(signBodySchema.safeParse(base).success).toBe(true);
    expect(signBodySchema.safeParse({ ...base, agreed: false }).success).toBe(false);
    expect(signBodySchema.safeParse({ ...base, signerName: "א" }).success).toBe(false);
    expect(signBodySchema.safeParse({ ...base, signatureImage: "data:image/svg+xml;base64,AAAA" }).success).toBe(false);
  });

  it("an unsigned document past its last day reads expired; the WhatsApp message carries the link", () => {
    const now = new Date("2026-11-10T10:00:00Z");
    expect(shownSignatureState({ status: "viewed", expiresAt: "2026-11-09T10:00:00Z" }, now)).toBe("expired");
    expect(shownSignatureState({ status: "signed", expiresAt: "2026-11-09T10:00:00Z" }, now)).toBe("signed");
    expect(awaitsSignature({ status: "sent", expiresAt: null }, now)).toBe(true);
    expect(awaitsSignature({ status: "cancelled", expiresAt: null }, now)).toBe(false);
    expect(signatureLinkMessage("https://x.test/f/sign/t", "חוזה", "העסק")).toContain("https://x.test/f/sign/t");
    expect(signatureWhatsappHref("https://x.test/f/sign/t", "חוזה", null, "+972501234567")).toMatch(/^https:\/\/wa\.me\/972501234567\?text=/);
    expect(signatureWhatsappHref("https://x.test/f/sign/t", "חוזה", null, "050")).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it("the wording version the app stores is the shape the database accepts", () => {
    expect(SIGN_WORDING_VERSION).toMatch(/^[a-z0-9-]{1,40}$/);
    // review 5: the app's version and text are registered in app.signature_wording_versions, and only those are accepted
    expect(MIGRATION).toContain(`values ('${SIGN_WORDING_VERSION}', '${SIGN_WORDING}')`);
    expect(MIGRATION).toContain("not exists (select 1 from app.signature_wording_versions w where w.version = p_wording_version)");
  });

  it("review 6: the page writes its dates in the business's time zone", () => {
    // 22:30 UTC on 9 November is already 10 November in Israel, still 9 November in New York
    expect(signatureDateText("2026-11-09T22:30:00Z", "Asia/Jerusalem")).toContain("10");
    expect(signatureDateText("2026-11-09T22:30:00Z", "America/New_York")).toContain("9");
    expect(signatureDateText("2026-11-09T22:30:00Z", "Not/AZone")).toBe(signatureDateText("2026-11-09T22:30:00Z", "Asia/Jerusalem"));
    expect(signatureDateText("not a date", "Asia/Jerusalem")).toBe("");
  });

});

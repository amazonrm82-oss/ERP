import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { quoteInPersonPath, recordPathOf, signatureInPersonPath } from "@/features/in-person-signing/texts";
import type { PdfLine } from "@/features/pdf/document";
import { inPersonLine, readSignature } from "@/features/quotes/signed-pdf";
import { readSignedDocumentSource, signedDocumentPdf } from "@/features/signatures/pdf";
import { SIGN_WORDING, SIGN_WORDING_VERSION } from "@/features/signatures/public";

const MIGRATION = readFileSync(join(__dirname, "../../supabase/migrations/20261006021227_in_person_signing.sql"), "utf8");
const ORG = "11111111-1111-4111-8111-111111111111";

const documentSource = (signature: Record<string, unknown> = {}) => ({
  document: { title: "הסכם שירות", body: "נערך בין העסק לבין דנה כהן." },
  business: { name: "העסק", tax_id: null, phone: null, email: null },
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
    ...signature,
  },
});

const quoteBlock = (extra: Record<string, unknown> = {}) => ({
  signer_name: "נועה לוי",
  kind: "typed",
  image: null,
  decided_at: "2026-11-10T08:30:00Z",
  time_zone: "Asia/Jerusalem",
  wording_version: "draft-2026-10-18",
  fingerprint: "b".repeat(64),
  ...extra,
});

const signatureLines = (doc: ReturnType<typeof signedDocumentPdf>): string[] => {
  const block = doc.blocks.find((b) => b.kind === "signature");
  return block && block.kind === "signature" ? block.lines.map((line: PdfLine) => line.text) : [];
};

describe("SGN-07: in-person signing", () => {
  it("prints that the document was signed face to face, with the rep present", () => {
    const read = readSignedDocumentSource(documentSource({ in_person: true, in_person_by_name: "יוסי מהצוות" }));
    if (!("source" in read)) throw new Error("source refused");
    expect(read.source.signature.inPerson).toEqual({ repName: "יוסי מהצוות" });
    expect(signatureLines(signedDocumentPdf(read.source, null))).toContain("נחתם פנים אל פנים, בנוכחות יוסי מהצוות");
  });

  it("a signature through the link, or an older answer, prints no in-person line", () => {
    for (const extra of [{}, { in_person: false, in_person_by_name: null }]) {
      const read = readSignedDocumentSource(documentSource(extra));
      if (!("source" in read)) throw new Error("source refused");
      expect(read.source.signature.inPerson).toBeNull();
      expect(signatureLines(signedDocumentPdf(read.source, null)).some((line) => line.includes("פנים אל פנים"))).toBe(false);
    }
  });

  it("a rep without a name in the profile is not named", () => {
    expect(inPersonLine({ repName: null })).toBe("נחתם פנים אל פנים, במכשיר של העסק");
    const read = readSignature(quoteBlock({ in_person: true, in_person_by_name: null }));
    expect("signature" in read && read.signature.inPerson).toEqual({ repName: null });
    const plain = readSignature(quoteBlock());
    expect("signature" in plain && plain.signature.inPerson).toBeNull();
  });

  it("links to the in-person screens and back to the document's record", () => {
    expect(signatureInPersonPath(ORG, "d")).toBe(`/o/${ORG}/signatures/d/sign`);
    expect(quoteInPersonPath(ORG, "q")).toBe(`/o/${ORG}/quotes/q/sign`);
    expect(recordPathOf(ORG, { lead_id: null, contact_id: "c", company_id: null, deal_id: null })).toContain("/contacts/c");
    expect(recordPathOf(ORG, { lead_id: null, contact_id: null, company_id: null, deal_id: null })).toBeNull();
  });

  it("the migration keeps the rep's device as the user agent only, never an IP, and grants nothing to anon", () => {
    expect(MIGRATION).not.toMatch(/^\s*drop\s/im);
    expect(MIGRATION).not.toMatch(/delete\s+from/i);
    expect(MIGRATION).not.toContain("\\u");
    expect(MIGRATION).not.toMatch(/grant execute on function [^;]* to anon/);
    expect(MIGRATION.match(/null, left\(nullif\(btrim\(coalesce\(p_user_agent, ''\)\), ''\), 500\)/g)?.length).toBe(2);
  });
});

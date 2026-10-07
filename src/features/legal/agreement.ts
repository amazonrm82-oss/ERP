import { LEGAL_DOCUMENTS, LEGAL_VERSION, type LegalDocument } from "./documents";

// The documents every user signs before using the product, and again when they change.
export const AGREEMENT_SLUGS = ["terms", "privacy", "dpa"] as const;
export const AGREEMENT_VERSION = LEGAL_VERSION;

export function agreementDocuments(): LegalDocument[] {
  return AGREEMENT_SLUGS.map((slug) => LEGAL_DOCUMENTS.find((doc) => doc.slug === slug)).filter((doc): doc is LegalDocument => Boolean(doc));
}

/** The documents as plain text, exactly as stored with the signature. */
export function agreementSnapshot(): Array<{ slug: string; title: string; version: string; text: string }> {
  return agreementDocuments().map((doc) => ({
    slug: doc.slug,
    title: doc.title,
    version: doc.version,
    text: doc.sections.map((section, i) => `${i + 1}. ${section.heading}\n${section.paragraphs.join("\n")}`).join("\n\n"),
  }));
}

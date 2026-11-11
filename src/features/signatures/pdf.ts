// SGN-02: the signed document as a PDF: the business on the letterhead, the document's title and its filled text as the
// customer read it, then the signature block (name, the drawn signature or the typed name, the time in the business's zone,
// the wording version and the fingerprint of what was signed). Pure, so it is unit-tested; the server renders it
// (pdf-server.ts) with src/features/pdf/.

import { z } from "zod";

import { parseNote, type Inline } from "@/features/activities/markdown";
import { ltr, type PdfBlock, type PdfDocument, type PdfLine, type PdfLogo } from "@/features/pdf/document";
import { checkSignaturePng, inPersonLine, signedAtText, type SignatureProblem } from "@/features/quotes/signed-pdf";
import { SIGNATURE_IMAGE, SIGNATURE_IMAGE_MAX } from "@/features/quotes/decision";

import { TEXT_ERASED_LINE } from "./states";


/** What a signed PDF is rendered from (public.signature_pdf_public / signature_pdf_allowed). */
export type SignedDocumentSource = {
  title: string;
  body: string;
  // (234) ב: a person's erasure changed the text after it was signed
  textErased: boolean;
  // delta review: the fingerprint of the text as the render read it, passed back when storing (the database refuses a
  // render of a text that changed since); the PDF prints signature.fingerprint, the evidence of what was signed
  textFingerprint: string;
  business: { name: string; taxId: string | null; phone: string | null; email: string | null };
  logoPath: string | null;
  color: string | null;
  signature: {
    signerName: string;
    idNumber: string | null;
    kind: "drawn" | "typed";
    image: Uint8Array | null;
    signedAt: string;
    timeZone: string;
    wordingVersion: string;
    // review 5: the stored text of that version (app.signature_wording_versions), null when it is not registered
    wording: string | null;
    fingerprint: string;
    // SGN-07: signed face to face on the rep's device, and the rep's name (null when the profile has none)
    inPerson: { repName: string | null } | null;
  };
};

const optional = (max: number) => z.string().max(max).nullable().optional();

const sourceSchema = z.object({
  document: z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(30000),
    text_erased: z.boolean().optional(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  business: z.object({ name: z.string().min(1).max(200), tax_id: optional(40), phone: optional(40), email: optional(254) }),
  brand: z.object({ logo: optional(300), color: optional(20) }),
  signature: z.object({
    signer_name: z.string().min(1).max(200),
    id_number: optional(12),
    kind: z.enum(["drawn", "typed"]),
    image: z.string().max(SIGNATURE_IMAGE_MAX).regex(SIGNATURE_IMAGE).nullable().optional(),
    signed_at: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
    time_zone: z.string().min(1).max(64),
    wording_version: z.string().min(1).max(40),
    wording: z.string().min(1).max(2000).nullable().optional(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    in_person: z.boolean().optional(),
    in_person_by_name: z.string().min(1).max(200).nullable().optional(),
  }),
});

/** The database's answer as the PDF's source, or why it cannot be used ("shape", or the drawn image's problem). */
export function readSignedDocumentSource(raw: unknown): { source: SignedDocumentSource } | { problem: "shape" | SignatureProblem } {
  const parsed = sourceSchema.safeParse(raw);
  if (!parsed.success) return { problem: "shape" };
  const r = parsed.data;
  let image: Uint8Array | null = null;
  if (r.signature.kind === "drawn") {
    if (!r.signature.image) return { problem: "format" };
    const checked = checkSignaturePng(r.signature.image);
    if ("problem" in checked) return checked;
    image = checked.bytes;
  }
  return {
    source: {
      title: r.document.title,
      body: r.document.body,
      textErased: r.document.text_erased === true,
      textFingerprint: r.document.fingerprint ?? r.signature.fingerprint,
      business: { name: r.business.name, taxId: r.business.tax_id ?? null, phone: r.business.phone ?? null, email: r.business.email ?? null },
      logoPath: r.brand.logo ?? null,
      color: r.brand.color ?? null,
      signature: {
        signerName: r.signature.signer_name,
        idNumber: r.signature.id_number ?? null,
        kind: r.signature.kind,
        image,
        signedAt: r.signature.signed_at,
        timeZone: r.signature.time_zone,
        wordingVersion: r.signature.wording_version,
        wording: r.signature.wording ?? null,
        fingerprint: r.signature.fingerprint,
        inPerson: r.signature.in_person === true ? { repName: r.signature.in_person_by_name ?? null } : null,
      },
    },
  };
}

/** The plain text of REC-04 inline marks (a link keeps its address, a mention its name). */
function inlineText(parts: readonly Inline[]): string {
  return parts
    .map((part) => {
      if (part.kind === "text") return part.text;
      if (part.kind === "mention") return `@${part.name}`;
      if (part.kind === "bold") return inlineText(part.children);
      const words = inlineText(part.children);
      const address = part.href.replace(/^(mailto|tel):/, "");
      return words === address ? ltr(address) : `${words} (${ltr(address)})`;
    })
    .join("");
}

const wholeBold = (parts: readonly Inline[]) => parts.length > 0 && parts.every((part) => part.kind === "bold" || (part.kind === "text" && part.text.trim() === ""));

/** The document's text (REC-04's cleaned Markdown) as PDF paragraphs: one per line, a line all in bold printed bold. */
export function bodyBlocks(body: string): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  for (const block of parseNote(body)) {
    if (block.kind === "paragraph") {
      for (const line of block.lines) {
        const text = inlineText(line).trim();
        if (text) blocks.push({ kind: "paragraph", text, bold: wholeBold(line) || undefined });
      }
    } else if (block.kind === "bullets") {
      for (const item of block.items) blocks.push({ kind: "paragraph", text: `• ${inlineText(item).trim()}` });
    } else {
      block.items.forEach((item, index) => blocks.push({ kind: "paragraph", text: `${block.start + index}. ${inlineText(item).trim()}` }));
    }
  }
  return blocks;
}

/** The signed document. */
export function signedDocumentPdf(source: SignedDocumentSource, logo: PdfLogo | null): PdfDocument {
  const s = source.signature;
  const from: PdfLine[] = [{ text: source.business.name, bold: true }];
  if (source.business.taxId) from.push({ text: `מספר עוסק ${ltr(source.business.taxId)}`, muted: true });
  if (source.business.phone) from.push({ text: ltr(source.business.phone), muted: true });
  if (source.business.email) from.push({ text: ltr(source.business.email), muted: true });
  // the stored text of the version that was signed, never today's constant
  const wording = s.wording ? `נוסח האישור (גרסה ${ltr(s.wordingVersion)}): ${s.wording}` : `גרסת נוסח האישור: ${ltr(s.wordingVersion)}`;
  const facts: PdfLine[] = [{ text: `שם החותם: ${s.signerName}`, bold: true }];
  if (s.idNumber) facts.push({ text: `תעודת זהות: ${ltr(s.idNumber)}` });
  facts.push(
    { text: `נחתם ב-${signedAtText(s.signedAt, s.timeZone)}` },
    ...(s.inPerson ? [{ text: inPersonLine(s.inPerson) }] : []),
    { text: wording, muted: true, size: 8.5 },
    { text: `טביעת האצבע של המסמך, SHA-256: ${ltr(s.fingerprint)}`, muted: true, size: 7.5 },
  );
  return {
    title: `${source.title} (חתום)`,
    heading: source.title,
    color: source.color,
    logo,
    from,
    meta: [{ text: "נחתם בידי הלקוח", bold: true, accent: true }],
    blocks: [
      ...bodyBlocks(source.body),
      ...(source.textErased ? [{ kind: "paragraph" as const, text: TEXT_ERASED_LINE }] : []),
      { kind: "rule" },
      {
        kind: "signature",
        title: "חתימת הלקוח",
        image: s.image ? { data: s.image, kind: "png" } : null,
        typedName: s.kind === "typed" ? s.signerName : null,
        lines: facts,
      },
    ],
    pageNote: `${source.title}, חתום`,
  };
}

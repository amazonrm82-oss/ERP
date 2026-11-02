import "server-only";

import { logoPublicUrl } from "@/features/branding/logo";
import { FILES_BUCKET } from "@/features/files/types";
import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import { dbErrorMessage } from "@/lib/errors";
import { createServiceClient } from "@/lib/supabase/service";

import type { QuoteDocumentData } from "./design-server";
import { isQuotePdfPath, sha256Hex } from "./pdf-fingerprint";
import { publicQuoteFrom, QUOTE_LINK_TOKEN } from "./public";
import { quoteSignedPdfDocument, signatureFrom, signedQuotePdfFileName, type QuoteSignature } from "./signed-pdf";

// QUO-09 signed PDF (owner, 1 November 2026, answers (3) א and (33) ב; CLAUDE.md hard rule 5, QUO-06's pattern): the server
// alone writes an accepted quote's signed PDF, with the service key, through two service_role functions and nothing else:
// * the customer's decide route, right after public.quote_public_answer answered 'accepted' (no staff session: the link's token
//   is the right): public.quote_signed_pdf_public(token) answers what to render (the page's own answer, no view counted, plus
//   the signature block), and public.quote_signed_pdf_public_store(token, ...) writes it;
// * staff ("יצירת PDF חתום"), after public.quote_signed_pdf_allowed answered the signature block with the person's own session
//   (pdf-server.ts): public.quote_signed_pdf_store(org, quote, user, ...), which checks that user again.
// Both upload (upsert off) only to the path the database answered, then name that path again to confirm the row. A failure never
// touches the acceptance: it has committed before any of this runs.

type Answer = { status: "upload"; path: string } | { status: "stored"; fileId: string } | { status: "busy" } | { status: "changed" };

function answerFrom(raw: unknown): Answer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { status?: unknown; path?: unknown; file_id?: unknown };
  if (r.status === "busy" || r.status === "changed") return { status: r.status };
  if (r.status === "upload" && isQuotePdfPath(r.path)) return { status: "upload", path: r.path };
  if (r.status === "stored" && typeof r.file_id === "string" && /^[0-9a-f-]{36}$/.test(r.file_id)) return { status: "stored", fileId: r.file_id };
  return null;
}

export type SignedStoreResult = { ok: true; fileId: string } | { ok: false; message: string; busy?: boolean };

const NOT_MADE = "קובץ ה-PDF החתום לא נשמר. נסו שוב בעוד רגע.";
const NOT_PERMITTED = "אין לכם הרשאה לשמור את ה-PDF החתום של ההצעה הזאת.";

type Ask = (path: string | null) => Promise<{ data: unknown; error: { code?: string; message: string } | null }>;

/** QUO-06's two calls around the upload, for one signed PDF. */
async function writeThrough(ask: Ask, bytes: Uint8Array, orgId: string | null): Promise<SignedStoreResult> {
  const service = createServiceClient();
  if (!service) return { ok: false, message: NOT_MADE };
  const first = await ask(null);
  if (first.error) return { ok: false, message: first.error.code === "42501" ? NOT_PERMITTED : dbErrorMessage(first.error, NOT_MADE) };
  const answer = answerFrom(first.data);
  if (!answer || answer.status === "changed") return { ok: false, message: NOT_MADE };
  if (answer.status === "stored") return { ok: true, fileId: answer.fileId };
  if (answer.status === "busy") return { ok: false, message: NOT_MADE, busy: true };
  // only the path the database named for this attempt (staff: of their own business), never over an existing object
  if (orgId !== null && !isQuotePdfPath(answer.path, orgId)) return { ok: false, message: NOT_MADE };
  const upload = await service.storage.from(FILES_BUCKET).upload(answer.path, bytes, { contentType: "application/pdf", upsert: false });
  const second = await ask(answer.path);
  const confirmed = second.error ? null : answerFrom(second.data);
  if (confirmed?.status === "stored") return { ok: true, fileId: confirmed.fileId };
  if (upload.error) return { ok: false, message: NOT_MADE };
  if (second.error) return { ok: false, message: dbErrorMessage(second.error, NOT_MADE) };
  return { ok: false, message: NOT_MADE, busy: confirmed?.status === "busy" };
}

/** Renders the signed document; a logo that does not load is left out. */
export async function renderSignedQuotePdf(data: QuoteDocumentData, signature: QuoteSignature): Promise<Uint8Array> {
  return renderPdf(quoteSignedPdfDocument(data, await loadPdfLogo(data.logoUrl), signature));
}

/** Staff: writes the signed PDF rendered with their session's data, for that user (checked again in the database). */
export async function writeSignedQuotePdfAsServer(input: {
  orgId: string;
  quoteId: string;
  userId: string;
  bytes: Uint8Array;
  name: string;
  fingerprint: string;
}): Promise<SignedStoreResult> {
  const service = createServiceClient();
  if (!service) return { ok: false, message: NOT_MADE };
  const args = {
    p_org: input.orgId,
    p_quote: input.quoteId,
    p_user: input.userId,
    p_size: input.bytes.length,
    p_sha256: sha256Hex(input.bytes),
    p_name: input.name,
    p_fingerprint: input.fingerprint,
  };
  return writeThrough(async (path) => service.rpc("quote_signed_pdf_store", { ...args, p_path: path }), input.bytes, input.orgId);
}

/**
 * The customer's route, after the acceptance committed: makes and keeps the signed PDF of the quote the link shows. Never
 * throws; a failure logs one line without the token, and staff make the file later from the quote's screen.
 */
export async function storeSignedQuotePdfForCustomer(token: string): Promise<void> {
  if (!QUOTE_LINK_TOKEN.test(token)) return;
  try {
    const service = createServiceClient();
    if (!service) return;
    const { data, error } = await service.rpc("quote_signed_pdf_public", { p_token: token });
    if (error) {
      console.error("QUO-09 signed PDF: the source read failed", error.code);
      return;
    }
    const raw = data as Record<string, unknown> | null;
    if (!raw || raw.done === true || raw.unavailable === true || raw.rate_limited === true) return;
    const page = publicQuoteFrom(raw);
    const signature = signatureFrom(raw.signature);
    if (!page || !signature || page.quote.status !== "accepted") {
      console.error("QUO-09 signed PDF: the source had another shape");
      return;
    }
    const doc: QuoteDocumentData = {
      design: page.design,
      color: page.color,
      logoUrl: logoPublicUrl(page.logoPath),
      business: page.business,
      customer: page.customer,
      quote: page.quote,
      lines: page.lines,
      schedule: page.schedule,
    };
    const bytes = await renderSignedQuotePdf(doc, signature);
    const args = {
      p_token: token,
      p_size: bytes.length,
      p_sha256: sha256Hex(bytes),
      p_name: signedQuotePdfFileName(page.quote.numberDisplay, page.quote.title),
      p_fingerprint: signature.fingerprint,
    };
    const stored = await writeThrough(async (path) => service.rpc("quote_signed_pdf_public_store", { ...args, p_path: path }), bytes, null);
    if (!stored.ok) console.error("QUO-09 signed PDF: not stored", stored.busy ? "busy" : "failed");
  } catch (err) {
    console.error("QUO-09 signed PDF: failed", err instanceof Error ? err.name : "error");
  }
}

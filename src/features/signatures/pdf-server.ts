import "server-only";

import { logoPublicUrl } from "@/features/branding/logo";
import { FILES_BUCKET } from "@/features/files/types";
import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import { isQuotePdfPath, sha256Hex } from "@/features/quotes/pdf-fingerprint";
import { errorFields } from "@/lib/log";
import { serverLog } from "@/lib/log-server";
import { createServiceClient } from "@/lib/supabase/service";

import { readSignedDocumentSource, signedDocumentPdf, type SignedDocumentSource } from "./pdf";
import { SIGNATURE_LINK_TOKEN } from "./public";

// SGN-02 (owner, 9 November 2026, answer (191) א; CLAUDE.md hard rule 5, QUO-09's pattern): the server alone writes a signed
// document's PDF, with the service key, through these service_role functions and nothing else:
// * the customer's sign route, right after public.signature_public_sign answered 'signed' (no staff session: the link's token
//   is the right): public.signature_pdf_public(token) answers what to render, public.signature_pdf_public_store(token, ...)
//   writes it;
// * staff (owners and admins, "יצירת PDF חתום"), after public.signature_pdf_allowed answered the source with the person's own
//   session (actions.ts): public.signature_pdf_store(org, doc, user, ...), which checks that user again.
// The first call answers a fresh path; the PDF is uploaded there (upsert off), then the second call names the path and the
// database checks the object and keeps the row. A failure never touches the signature: it has committed before this runs.

type Answer = { status: "upload"; path: string } | { status: "stored"; fileId: string } | { status: "changed" };

function answerFrom(raw: unknown): Answer | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as { status?: unknown; path?: unknown; file_id?: unknown };
  if (r.status === "changed") return { status: "changed" };
  if (r.status === "upload" && isQuotePdfPath(r.path)) return { status: "upload", path: r.path };
  if (r.status === "stored" && typeof r.file_id === "string" && /^[0-9a-f-]{36}$/.test(r.file_id)) return { status: "stored", fileId: r.file_id };
  return null;
}

export type SignedPdfResult = { ok: true; fileId: string } | { ok: false; message: string };

const NOT_MADE = "קובץ ה-PDF החתום לא נשמר. נסו שוב בעוד רגע.";
const NOT_PERMITTED = "אין לכם הרשאה לשמור את ה-PDF החתום של המסמך הזה.";
// review 4: the business is at its storage cap (no exemption for the signed PDF)
export const STORAGE_FULL = "האחסון של העסק מלא, ולכן ה-PDF החתום לא נשמר. מפנים מקום בקבצים או משדרגים את החבילה, ואז לוחצים \"יצירת PDF חתום\".";

type Ask = (path: string | null) => Promise<{ data: unknown; error: { code?: string; hint?: string; message: string } | null }>;

/** The two calls around the upload, for one signed PDF. */
async function writeThrough(ask: Ask, bytes: Uint8Array, orgId: string | null): Promise<SignedPdfResult> {
  const service = createServiceClient();
  if (!service) return { ok: false, message: NOT_MADE };
  const first = await ask(null);
  if (first.error) return { ok: false, message: first.error.code === "42501" ? NOT_PERMITTED : NOT_MADE };
  const answer = answerFrom(first.data);
  if (!answer || answer.status === "changed") return { ok: false, message: NOT_MADE };
  if (answer.status === "stored") return { ok: true, fileId: answer.fileId };
  // only the path the database named for this attempt (staff: of their own business), never over an existing object
  if (orgId !== null && !isQuotePdfPath(answer.path, orgId)) return { ok: false, message: NOT_MADE };
  const upload = await service.storage.from(FILES_BUCKET).upload(answer.path, bytes, { contentType: "application/pdf", upsert: false });
  if (upload.error) return { ok: false, message: NOT_MADE };
  const second = await ask(answer.path);
  if (second.error?.hint === "limit:storage_gb") return { ok: false, message: STORAGE_FULL };
  const confirmed = second.error ? null : answerFrom(second.data);
  if (confirmed?.status === "stored") return { ok: true, fileId: confirmed.fileId };
  return { ok: false, message: NOT_MADE };
}

/** Renders the signed document; a logo that does not load is left out. */
export async function renderSignedDocumentPdf(source: SignedDocumentSource): Promise<Uint8Array> {
  return renderPdf(signedDocumentPdf(source, await loadPdfLogo(logoPublicUrl(source.logoPath))));
}

/** Staff: writes the signed PDF rendered from the source their session read, for that user (checked again in the database). */
export async function writeSignedDocumentPdfAsServer(input: { orgId: string; docId: string; userId: string; source: SignedDocumentSource }): Promise<SignedPdfResult> {
  const service = createServiceClient();
  if (!service) return { ok: false, message: NOT_MADE };
  const bytes = await renderSignedDocumentPdf(input.source);
  const args = {
    p_org: input.orgId,
    p_doc: input.docId,
    p_user: input.userId,
    p_size: bytes.length,
    p_sha256: sha256Hex(bytes),
    p_fingerprint: input.source.signature.fingerprint,
  };
  return writeThrough(async (path) => service.rpc("signature_pdf_store", { ...args, p_path: path }), bytes, input.orgId);
}

/**
 * The customer's route, after the signature committed: makes and keeps the signed PDF. Never throws; a failure logs one line
 * without the token, and staff make the file later from the record.
 */
export async function storeSignedDocumentPdfForCustomer(token: string): Promise<void> {
  if (!SIGNATURE_LINK_TOKEN.test(token)) return;
  try {
    const service = createServiceClient();
    if (!service) return;
    const { data, error } = await service.rpc("signature_pdf_public", { p_token: token });
    if (error) {
      void serverLog("error", "signature.pdf_source_failed", { code: error.code });
      return;
    }
    const raw = data as Record<string, unknown> | null;
    if (!raw || raw.done === true || raw.unavailable === true) return;
    const read = readSignedDocumentSource(raw);
    if ("problem" in read) {
      // the reason code only (shape|format|header|size|data), never the token or the signature
      void serverLog("error", "signature.pdf_source_refused", { reason: read.problem });
      return;
    }
    const bytes = await renderSignedDocumentPdf(read.source);
    const args = { p_token: token, p_size: bytes.length, p_sha256: sha256Hex(bytes), p_fingerprint: read.source.signature.fingerprint };
    const stored = await writeThrough(async (path) => service.rpc("signature_pdf_public_store", { ...args, p_path: path }), bytes, null);
    if (!stored.ok) void serverLog("error", "signature.pdf_not_stored", { reason: stored.message === STORAGE_FULL ? "storage_full" : "not_stored" });
  } catch (err) {
    void serverLog("error", "signature.pdf_failed", { error_name: errorFields(err).error_name });
  }
}

import "server-only";

import { after } from "next/server";

import { FILES_BUCKET } from "@/features/files/types";
import { matchesFingerprint, pdfHeaders, publicPdfAnswerFrom } from "@/features/quotes/pdf-fingerprint";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { markNotFound } from "@/lib/public-not-found";
import { rateLimitedJson, rateLimitedText } from "@/lib/public-rate-limit";
import { serverLog } from "@/lib/log-server";
import { createServiceClient } from "@/lib/supabase/service";

import { storeSignedDocumentPdfForCustomer } from "./pdf-server";
import {
  isSignStatus,
  publicSignatureFrom,
  SIGN_MESSAGES,
  SIGN_WORDING_VERSION,
  SIGNATURE_LINK_TOKEN,
  signBodySchema,
  statusSignatureFrom,
  type PublicSignatureDocument,
  type SignBody,
  type SignStatus,
  type StatusSignatureDocument,
} from "./public";

// SGN-02 (owner, 9 November 2026, answer (191) א): the customer's page of a document sent for signature, in the approved
// pattern for secret-link pages (CLAUDE.md hard rule 5): the server reads only through public.signature_public() and signs
// only through public.signature_public_sign() (security definer, service_role only), which check the token and answer only
// what the page needs. No table is reached directly; no cookies, no visitor id. The sender's IP reaches the database only as
// the keyed hash of FXS-11 (scope "signature"), for the view limit; a signature keeps the full IP and browser as evidence (as
// QUO-09). Right after a signature the signed PDF is written (pdf-server.ts), after the answer went out.
// Owner (223) ב: after signing, the customer downloads the signed PDF through public.signature_public_pdf() only (path,
// SHA-256 and name; the link the document was signed with; 20 per sender in 10 minutes); the object is read with the service
// key, compared with the SHA-256 and sent; nothing else is read.

export type PublicSignatureState = PublicSignatureDocument | StatusSignatureDocument | "not-found" | "rate-limited" | "not-configured";

/** The document behind a customer's link (a view: 120 per link and 60 per sender in 10 minutes). */
export async function getPublicSignature(token: string, ip: string | null): Promise<PublicSignatureState> {
  if (!SIGNATURE_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("signature_public", { p_token: token, p_ip_hash: keyedIpHash(ip, "signature") });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`signature_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  // OPS-02 review: a malformed answer is an error, never "not found" (which would count as a miss of the shared sender limit)
  const shaped = statusSignatureFrom(data) ?? publicSignatureFrom(data);
  if (!shaped) throw new Error("signature_public answered an unexpected shape");
  return shaped;
}

const MAX_SIGN_BYTES = 350_000;
const NOT_FOUND = "המסמך לא נמצא, או שהקישור כבר לא בתוקף.";

type SignReply = { ok: true; status: SignStatus; message: string } | { ok: false; status?: SignStatus; message: string };
const reply = (status: number, body: SignReply) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** POST /api/forms/sign/<token>: the page's own script posts the signature as JSON. */
export async function handleSignatureSign(request: Request, token: string): Promise<Response> {
  if (!SIGNATURE_LINK_TOKEN.test(token)) return markNotFound(reply(404, { ok: false, message: NOT_FOUND }));
  const service = createServiceClient();
  if (!service) return reply(503, { ok: false, message: "המסמך אינו זמין כרגע." });
  if (Number(request.headers.get("content-length") ?? 0) > MAX_SIGN_BYTES) return reply(413, { ok: false, message: SIGN_MESSAGES.invalid });
  let parsed: SignBody;
  try {
    const raw = await request.text();
    if (raw.length > MAX_SIGN_BYTES) return reply(413, { ok: false, message: SIGN_MESSAGES.invalid });
    const body = signBodySchema.safeParse(JSON.parse(raw));
    if (!body.success) return reply(400, { ok: false, status: "invalid", message: SIGN_MESSAGES.invalid });
    parsed = body.data;
  } catch {
    return reply(400, { ok: false, status: "invalid", message: SIGN_MESSAGES.invalid });
  }

  const { data, error } = await service.rpc("signature_public_sign", {
    p_token: token,
    p_fingerprint: parsed.fingerprint,
    p_signer_name: parsed.signerName,
    p_id_number: parsed.idNumber || null,
    p_signature_kind: parsed.signatureKind,
    p_signature_image: parsed.signatureKind === "drawn" ? parsed.signatureImage : null,
    p_wording_version: SIGN_WORDING_VERSION,
    p_agreed: parsed.agreed,
    p_ip: clientIp(request.headers)?.slice(0, 64) ?? null,
    p_user_agent: request.headers.get("user-agent")?.slice(0, 500) ?? null,
  });
  if (error) {
    if (error.code === "P0002") return markNotFound(reply(404, { ok: false, message: NOT_FOUND }));
    void serverLog("error", "signature.sign_failed", { code: error.code });
    return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  }
  const status = (data as { status?: unknown } | null)?.status;
  if (!isSignStatus(status)) return reply(500, { ok: false, message: "משהו השתבש. נסו שוב בעוד רגע." });
  // OPS-02: the shared 429 (Retry-After, never cached)
  if (status === "rate_limited") return rateLimitedJson({ ok: false, status, message: SIGN_MESSAGES[status] });
  if (status === "signed") {
    // the signed PDF is made after the answer went out; a failure is left for staff (the record's card)
    after(() => storeSignedDocumentPdfForCustomer(token));
    return reply(200, { ok: true, status, message: SIGN_MESSAGES[status] });
  }
  return reply(409, { ok: false, status, message: SIGN_MESSAGES[status] });
}


const pdfText = (status: number, body: string) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
const PDF_UNAVAILABLE = "קובץ ה-PDF החתום עוד לא מוכן. נסו שוב בעוד דקה.";

/** GET /api/forms/sign/<token>/pdf: the signed PDF, after signing, through the link it was signed with. */
export async function handleSignaturePdfDownload(request: Request, token: string): Promise<Response> {
  if (!SIGNATURE_LINK_TOKEN.test(token)) return markNotFound(pdfText(404, NOT_FOUND));
  const service = createServiceClient();
  if (!service) return pdfText(503, PDF_UNAVAILABLE);
  const { data, error } = await service.rpc("signature_public_pdf", {
    p_token: token,
    p_ip_hash: keyedIpHash(clientIp(request.headers), "signature"),
  });
  if (error) {
    if (error.code === "P0002") return markNotFound(pdfText(404, NOT_FOUND));
    void serverLog("error", "signature.public_pdf_failed", { code: error.code });
    return pdfText(500, "משהו השתבש. נסו שוב בעוד רגע.");
  }
  const answer = publicPdfAnswerFrom(data);
  if (!answer) return pdfText(500, "משהו השתבש. נסו שוב בעוד רגע.");
  if (answer.kind === "rate-limited") return rateLimitedText();
  if (answer.kind === "unavailable") return pdfText(404, PDF_UNAVAILABLE);
  const object = await service.storage.from(FILES_BUCKET).download(answer.path);
  if (object.error || !object.data) return pdfText(404, PDF_UNAVAILABLE);
  const bytes = new Uint8Array(await object.data.arrayBuffer());
  if (!matchesFingerprint(bytes, answer.sha256)) {
    // never the token in the log
    void serverLog("error", "signature.pdf_fingerprint_mismatch", { object_path: answer.path });
    return pdfText(409, PDF_UNAVAILABLE);
  }
  return new Response(bytes, { status: 200, headers: { ...pdfHeaders(answer.name, bytes.length), "X-Robots-Tag": "noindex" } });
}

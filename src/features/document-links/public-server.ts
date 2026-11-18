import "server-only";

import { FILES_BUCKET } from "@/features/files/types";
import { matchesFingerprint, pdfHeaders } from "@/features/quotes/pdf-fingerprint";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { markNotFound } from "@/lib/public-not-found";
import { RATE_LIMITED_PAGE_TEXT, rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { DOCUMENT_LINK_TOKEN, documentFileName, isDocumentLinkType, publicDocumentFrom, type PublicDocument } from "./public";

// DOC-15 (owner (414) א, 18 November 2026; CLAUDE.md hard rule 5's approved pattern for public secret-link pages): the
// customer's page of one accounting document reads only through public.document_public() (security definer, service_role
// only), which checks the token and answers only what the page shows; the file route only through
// public.document_public_file(), which answers the current PDF's storage path, SHA-256 and size. No table is reached directly;
// no cookies, no visitor id. The sender's IP reaches the database only as the keyed hash of FXS-11 (scope "document").

export type PublicDocumentState = PublicDocument | "not-found" | "rate-limited" | "not-configured";

export const DOCUMENT_MESSAGES = {
  "not-found": "הקישור אינו זמין. ייתכן שהוא בוטל או שהוחלף בקישור חדש. לקבלת קישור פנו לעסק ששלח אותו.",
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "דף המסמך אינו זמין כרגע.",
} as const;

const isRateLimited = (data: unknown) =>
  Boolean(data) && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true;

/** The document behind a customer's link (a view: 120 per link and 60 per sender in 10 minutes, with the file). */
export async function getPublicDocument(token: string, ip: string | null): Promise<PublicDocumentState> {
  if (!DOCUMENT_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("document_public", { p_token: token, p_ip_hash: keyedIpHash(ip, "document") });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`document_public failed: ${error.code} ${error.message}`);
  }
  if (isRateLimited(data)) return "rate-limited";
  // OPS-02 review: a malformed answer is an error, never "not found" (which would count as a miss of the shared sender limit)
  const shaped = publicDocumentFrom(data);
  if (!shaped) throw new Error("document_public answered an unexpected shape");
  return shaped;
}

const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });

const UNAVAILABLE = "קובץ ה-PDF של המסמך אינו זמין כרגע.";
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * GET /api/forms/doc/<token>/file (DOC-15): the document's current PDF. The object at the path the database answered is read
 * with the service key, compared with the SHA-256 the server kept (a server-written PDF) or, for a person's upload that has
 * none, with its confirmed size, and sent as a download named by the document's type and number only. Nothing else is read.
 */
export async function handleDocumentFileDownload(request: Request, token: string): Promise<Response> {
  if (!DOCUMENT_LINK_TOKEN.test(token)) return markNotFound(text(404, DOCUMENT_MESSAGES["not-found"]));
  const service = createServiceClient();
  if (!service) return text(503, DOCUMENT_MESSAGES["not-configured"]);
  const { data, error } = await service.rpc("document_public_file", {
    p_token: token,
    p_ip_hash: keyedIpHash(clientIp(request.headers), "document"),
  });
  if (error) {
    if (error.code === "P0002") return markNotFound(text(404, DOCUMENT_MESSAGES["not-found"]));
    await serverLog("error", "document_public.file_failed", { code: error.code, error: error.message });
    return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  }
  if (isRateLimited(data)) return rateLimitedText(RATE_LIMITED_PAGE_TEXT, { headers: { "Referrer-Policy": "no-referrer" } });
  const answer = (data ?? {}) as { unavailable?: unknown; path?: unknown; sha256?: unknown; size?: unknown; type?: unknown; number?: unknown };
  if (answer.unavailable === true) return text(404, UNAVAILABLE);
  const path = answer.path;
  if (
    typeof path !== "string" ||
    !/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(path) ||
    typeof answer.type !== "string" ||
    !isDocumentLinkType(answer.type) ||
    typeof answer.number !== "string"
  ) {
    return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  }
  const object = await service.storage.from(FILES_BUCKET).download(path);
  if (object.error || !object.data) return text(404, UNAVAILABLE);
  const bytes = new Uint8Array(await object.data.arrayBuffer());
  const sha = typeof answer.sha256 === "string" && HEX64.test(answer.sha256) ? answer.sha256 : null;
  const intact = sha ? matchesFingerprint(bytes, sha) : typeof answer.size === "number" && bytes.length === answer.size;
  if (!intact) {
    // never the token in the log
    await serverLog("error", "document_public.file_mismatch", { object_path: path });
    return text(409, UNAVAILABLE);
  }
  return new Response(bytes, {
    status: 200,
    headers: { ...pdfHeaders(documentFileName(answer.type, answer.number), bytes.length), "X-Robots-Tag": "noindex" },
  });
}

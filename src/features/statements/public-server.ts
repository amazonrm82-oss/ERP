import "server-only";

import { logoPublicUrl } from "@/features/branding/logo";
import { loadPdfLogo } from "@/features/pdf/logo";
import { renderPdf } from "@/features/pdf/render";
import { pdfHeaders } from "@/features/quotes/pdf-fingerprint";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { RATE_LIMITED_PAGE_TEXT, rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { publicStatementPdfDocument, statementPdfFileName } from "./pdf";
import { publicStatementFrom, STATEMENT_LINK_TOKEN, type PublicStatement } from "./public";
import { markNotFound } from "@/lib/public-not-found";

// BAL-04 (approved pattern for public secret-link pages, owner 8 October 2026; CLAUDE.md hard rule 5): the customer's
// statement page reads only through public.statement_public() (security definer, service_role only), which checks the token
// and answers only what the page shows. No table is reached directly; no cookies, no visitor id. The sender's IP reaches the
// database only as the keyed hash of FXS-11 (scope "statement"), for the view limit.

export type PublicStatementState = PublicStatement | "not-found" | "rate-limited" | "not-configured";

/** The statement behind a customer's link (a view: 120 per link and 60 per sender in 10 minutes). */
export async function getPublicStatement(token: string, ip: string | null): Promise<PublicStatementState> {
  if (!STATEMENT_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("statement_public", { p_token: token, p_ip_hash: keyedIpHash(ip, "statement") });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`statement_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  return publicStatementFrom(data) ?? "not-found";
}

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...extra },
  });

const PDF_MESSAGES = {
  "not-found": "הקישור אינו זמין. ייתכן שהוא בוטל או שהוחלף בקישור חדש. לקבלת קישור פנו לעסק ששלח אותו.",
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "דף החשבון אינו זמין כרגע.",
} as const;

/**
 * GET /api/forms/statement/<token>/pdf (BAL-04, owner 1 November 2026, answer (2) א): the statement page as a PDF, made here
 * for this request from the same one call the page makes (public.statement_public, the same limits; a download counts as a
 * view) and never stored or counted in the PDF quota. No other function, no table, no storage object is read with the key;
 * the logo comes from its public address. The file holds what the page shows, no ids.
 */
export async function handleStatementPdfDownload(request: Request, token: string): Promise<Response> {
  const state = await getPublicStatement(token, clientIp(request.headers));
  if (state === "not-found") return markNotFound(text(404, PDF_MESSAGES["not-found"]));
  if (state === "rate-limited") return rateLimitedText(PDF_MESSAGES["rate-limited"], { headers: { "Referrer-Policy": "no-referrer" } });
  if (state === "not-configured") return text(503, PDF_MESSAGES["not-configured"]);
  const bytes = await renderPdf(publicStatementPdfDocument(state, await loadPdfLogo(logoPublicUrl(state.logoPath))));
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...pdfHeaders(statementPdfFileName(state.customerName, state.today), bytes.length), "X-Robots-Tag": "noindex" },
  });
}

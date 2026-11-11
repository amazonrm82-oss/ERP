import "server-only";

import { FILES_BUCKET, opensInBrowser } from "@/features/files/types";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { markNotFound } from "@/lib/public-not-found";
import { RATE_LIMITED_PAGE_TEXT, rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { LIBRARY_LINK_TOKEN, publicLibraryFileFrom, publicLibraryItemFrom, type PublicLibraryItem } from "./public";

// LIB-02 (approved pattern for public secret-link pages, owner 11 November 2026; CLAUDE.md hard rule 5): the customer's page
// of a library item sent by a tracked link reads only through public.library_link_public() (security definer, service_role
// only), which checks the token, limits per link and per sender, counts the view, tells the rep once a business day and
// answers only the business's display fields and the item's public fields. Its file goes through
// public.library_link_public_file() (the same token rule and counters), which answers only the current file's path, name and
// type; the object is then handed over through a one-minute signed link, as the staff download does. No table is reached
// directly; no cookies, no visitor id. The sender's IP reaches the database only as the keyed hash of FXS-11 (scope "library").

export type PublicLibraryState = PublicLibraryItem | "not-found" | "rate-limited" | "not-configured";

/** The item behind a customer's link (a view: 120 calls per link and 60 per sender in 10 minutes). */
export async function getPublicLibraryItem(token: string, ip: string | null): Promise<PublicLibraryState> {
  if (!LIBRARY_LINK_TOKEN.test(token)) return "not-found";
  const service = createServiceClient();
  if (!service) return "not-configured";
  const { data, error } = await service.rpc("library_link_public", { p_token: token, p_ip_hash: keyedIpHash(ip, "library") });
  if (error) {
    if (error.code === "P0002") return "not-found";
    throw new Error(`library_link_public failed: ${error.code} ${error.message}`);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && (data as { rate_limited?: unknown }).rate_limited === true) {
    return "rate-limited";
  }
  // OPS-02 review: a malformed answer is an error, never "not found" (which would count as a miss of the shared sender limit)
  const shaped = publicLibraryItemFrom(data);
  if (!shaped) throw new Error("library_link_public answered an unexpected shape");
  return shaped;
}

export const LIBRARY_MESSAGES = {
  "not-found": "הקישור אינו זמין. ייתכן שהוא בוטל או שהתוכן כבר לא בתוקף. לקבלת קישור פנו לעסק ששלח אותו.",
  "rate-limited": RATE_LIMITED_PAGE_TEXT,
  "not-configured": "הדף אינו זמין כרגע.",
} as const;

const text = (status: number, body: string) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });

/**
 * GET /api/forms/lib/<token>/file: the item's current file. The database judges the token (the page's rule and counters; a
 * download is not a view) and answers the path; the object is reached with the service key only to make a 60-second signed
 * link to that path. PDFs and images open in the browser, anything else downloads (the staff route's rule, FXS-07).
 */
export async function handleLibraryFileDownload(request: Request, token: string): Promise<Response> {
  if (!LIBRARY_LINK_TOKEN.test(token)) return markNotFound(text(404, LIBRARY_MESSAGES["not-found"]));
  const service = createServiceClient();
  if (!service) return text(503, LIBRARY_MESSAGES["not-configured"]);
  const { data, error } = await service.rpc("library_link_public_file", {
    p_token: token,
    p_ip_hash: keyedIpHash(clientIp(request.headers), "library"),
  });
  if (error) {
    if (error.code === "P0002") return markNotFound(text(404, LIBRARY_MESSAGES["not-found"]));
    await serverLog("error", "library_link.file_failed", { code: error.code, error: error.message });
    return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  }
  const answer = publicLibraryFileFrom(data);
  if (!answer) return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  if (answer.kind === "rate-limited") return rateLimitedText(undefined, { headers: { "Referrer-Policy": "no-referrer" } });
  const view = opensInBrowser(answer.mimeType);
  const signed = await service.storage.from(FILES_BUCKET).createSignedUrl(answer.path, 60, view ? undefined : { download: answer.name });
  if (signed.error || !signed.data) return text(404, "הקובץ אינו זמין כרגע.");
  return new Response(null, {
    status: 303,
    headers: { Location: signed.data.signedUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" },
  });
}

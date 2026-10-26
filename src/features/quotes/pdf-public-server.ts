import "server-only";

import { FILES_BUCKET } from "@/features/files/types";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { createServiceClient } from "@/lib/supabase/service";

import { matchesFingerprint, pdfHeaders, publicPdfAnswerFrom } from "./pdf-fingerprint";
import { QUOTE_LINK_TOKEN } from "./public";

// QUO-06 follow-up, answer (1) (owner, 26 October 2026; CLAUDE.md hard rule 5): the customer downloads the stored PDF of
// the quote their link shows. The route calls only public.quote_public_pdf (security definer, service_role only), which
// checks the token with the rules of quote_public (the version shown, only while the page shows it in full), limits per
// link and per sender (the keyed IP hash, scope "quote"), counts a view and answers only the storage path, SHA-256 and
// name. The object at that path is read with the service key, compared with the SHA-256, and sent; nothing else is read.

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

const NOT_FOUND = "ההצעה לא נמצאה, או שהקישור כבר לא בתוקף.";
const UNAVAILABLE = "קובץ PDF של ההצעה אינו זמין כרגע.";

/** GET /api/forms/quote/<token>/pdf */
export async function handleQuotePdfDownload(request: Request, token: string): Promise<Response> {
  if (!QUOTE_LINK_TOKEN.test(token)) return text(404, NOT_FOUND);
  const service = createServiceClient();
  if (!service) return text(503, UNAVAILABLE);
  const { data, error } = await service.rpc("quote_public_pdf", {
    p_token: token,
    p_ip_hash: keyedIpHash(clientIp(request.headers), "quote"),
  });
  if (error) {
    if (error.code === "P0002") return text(404, NOT_FOUND);
    console.error("quote_public_pdf failed", error.code, error.message);
    return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  }
  const answer = publicPdfAnswerFrom(data);
  if (!answer) return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  if (answer.kind === "rate-limited") return text(429, "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.", { "Retry-After": "600" });
  if (answer.kind === "unavailable") return text(404, UNAVAILABLE);

  const object = await service.storage.from(FILES_BUCKET).download(answer.path);
  if (object.error || !object.data) return text(404, UNAVAILABLE);
  const bytes = new Uint8Array(await object.data.arrayBuffer());
  if (!matchesFingerprint(bytes, answer.sha256)) {
    // never the token in the log; staff see the damage on the quote's own download (review M1: never replaced automatically)
    console.error(`[QUO-06] stored quote PDF failed its SHA-256 check on the customer's link: ${answer.path}`);
    return text(409, UNAVAILABLE);
  }
  return new Response(bytes, { status: 200, headers: { ...pdfHeaders(answer.name, bytes.length), "X-Robots-Tag": "noindex" } });
}

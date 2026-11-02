import "server-only";

import { FILES_BUCKET } from "@/features/files/types";
import { matchesFingerprint, pdfHeaders, publicPdfAnswerFrom } from "@/features/quotes/pdf-fingerprint";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { rateLimitedText } from "@/lib/public-rate-limit";
import { createServiceClient } from "@/lib/supabase/service";

import { ORDER_LINK_TOKEN } from "./public";

// ORD-05 PDF (owner, 1 November 2026, answer (1) ב; CLAUDE.md hard rule 5, QUO-06's pattern): the customer downloads the
// stored PDF of the order their link opens. The route calls only public.order_public_pdf (security definer, service_role
// only), which checks the token with the rule of order_public (app.order_link_usable; a cancelled order has no file), limits
// per link (shared with the page) and per sender (the keyed IP hash, scope "order"), and answers only the storage path,
// SHA-256 and name. The object at that path is read with the service key, compared with the SHA-256, and sent; nothing else.

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });

const NOT_FOUND = "ההזמנה לא נמצאה, או שהקישור כבר לא בתוקף.";
const UNAVAILABLE = "קובץ PDF של ההזמנה אינו זמין כרגע.";

/** GET /api/forms/order/<token>/pdf */
export async function handleOrderPdfDownload(request: Request, token: string): Promise<Response> {
  if (!ORDER_LINK_TOKEN.test(token)) return text(404, NOT_FOUND);
  const service = createServiceClient();
  if (!service) return text(503, UNAVAILABLE);
  const { data, error } = await service.rpc("order_public_pdf", {
    p_token: token,
    p_ip_hash: keyedIpHash(clientIp(request.headers), "order"),
  });
  if (error) {
    if (error.code === "P0002") return text(404, NOT_FOUND);
    console.error("order_public_pdf failed", error.code, error.message);
    return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  }
  const answer = publicPdfAnswerFrom(data);
  if (!answer) return text(500, "משהו השתבש. נסו שוב בעוד רגע.");
  if (answer.kind === "rate-limited") return rateLimitedText();
  if (answer.kind === "unavailable") return text(404, UNAVAILABLE);

  const object = await service.storage.from(FILES_BUCKET).download(answer.path);
  if (object.error || !object.data) return text(404, UNAVAILABLE);
  const bytes = new Uint8Array(await object.data.arrayBuffer());
  if (!matchesFingerprint(bytes, answer.sha256)) {
    // never the token in the log; never replaced automatically (QUO-06 review M1)
    console.error(`[ORD-05] stored order PDF failed its SHA-256 check on the customer's link: ${answer.path}`);
    return text(409, UNAVAILABLE);
  }
  return new Response(bytes, { status: 200, headers: { ...pdfHeaders(answer.name, bytes.length), "X-Robots-Tag": "noindex" } });
}

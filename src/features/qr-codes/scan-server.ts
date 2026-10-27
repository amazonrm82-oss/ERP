import "server-only";

import { createServiceClient } from "@/lib/supabase/service";

import { qrInterstitialHtml } from "./interstitial";
import { isQrToken, qrScanTarget, type QrScanTarget } from "./redirect";

// BIZ-03: a QR scan, in the approved pattern for public secret-link pages (owner, 13 October 2026; hard rule 5): the
// server calls only public.qr_scan() (security definer, service_role only), which checks the token, counts the scan
// (a number per code and day, nothing about the visitor) and answers the stored target: a page of this site, or
// the code's own https link (BIZ-03, owner 18 October 2026), with the business's display name for the page shown before
// it (owner 27 October 2026). No table is reached directly; no IP, cookie or visitor id is read or kept.

export type QrScanResult = { ok: true; target: QrScanTarget } | { ok: false; reason: "not-found" | "not-configured" };

export async function scanQrCode(token: string): Promise<QrScanResult> {
  if (!isQrToken(token)) return { ok: false, reason: "not-found" };
  const service = createServiceClient();
  if (!service) return { ok: false, reason: "not-configured" };
  const { data, error } = await service.rpc("qr_scan", { p_token: token });
  if (error) {
    if (error.code === "P0002") return { ok: false, reason: "not-found" };
    throw new Error(`qr_scan failed: ${error.code} ${error.message}`);
  }
  const target = qrScanTarget(data);
  return target ? { ok: true, target } : { ok: false, reason: "not-found" };
}

const NOT_FOUND_PAGE = `<!doctype html>
<html lang="he" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>הקוד אינו פעיל</title></head>
<body style="font-family: system-ui, sans-serif; margin: 0; padding: 2rem 1rem; text-align: center; line-height: 1.6">
<h1 style="font-size: 1.25rem">הקוד הזה אינו פעיל</h1>
<p>הקישור שבקוד לא נמצא.</p>
</body>
</html>`;

const UNAVAILABLE_PAGE = NOT_FOUND_PAGE.replace("הקוד הזה אינו פעיל", "הקוד אינו זמין כרגע").replace(
  "הקישור שבקוד לא נמצא.",
  "נסו שוב בעוד כמה דקות.",
);

const html = (body: string, status: number) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });

/** The route's answer for a scan's target: a redirect to a page of this site, or the page before an external link. */
export function qrTargetResponse(target: QrScanTarget, nonce?: string): Response {
  // never cached: every scan reaches the counter, and a code switched off stops at once
  if (target.kind === "redirect") {
    return new Response(null, { status: 302, headers: { Location: target.location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return new Response(qrInterstitialHtml(target, nonce), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      // never inside another site's frame: the page names the business on our domain (the proxy's policy says the same)
      "X-Frame-Options": "DENY",
    },
  });
}

/** The route's answer: a redirect to a page of this site, the page before the code's own https link, or a short
 * Hebrew page. */
export async function qrScanResponse(token: string, nonce?: string): Promise<Response> {
  const result = await scanQrCode(token);
  if (result.ok) return qrTargetResponse(result.target, nonce);
  return result.reason === "not-configured" ? html(UNAVAILABLE_PAGE, 503) : html(NOT_FOUND_PAGE, 404);
}

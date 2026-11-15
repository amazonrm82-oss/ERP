import { DIGEST_STOP_TOKEN, digestStopPagePath } from "@/features/digest/stop";
import { handleDigestStop } from "@/features/digest/stop-server";
import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";
import { guardPublicRoute } from "@/lib/public-sender-server";

// USR-11 / WAB-03 (owner (377) ב): the stop page's button (JSON) and a mail program's one-click stop (RFC 8058) post here. Only a
// POST changes anything.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const oneClick = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, oneClick ? "text" : "json", () => handleDigestStop(request, token), {
    body: { ok: false, message: RATE_LIMITED_TEXT },
    headers: { "Referrer-Policy": "no-referrer" },
  });
}

// someone (or a scanner) opening this address gets the stop page; nothing is read or written here
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (!DIGEST_STOP_TOKEN.test(token)) return new Response(null, { status: 404, headers });
  return new Response(null, { status: 303, headers: { ...headers, Location: new URL(digestStopPagePath(token), request.url).toString() } });
}

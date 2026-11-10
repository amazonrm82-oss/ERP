import { PREFERENCES_TOKEN, unsubscribePagePath } from "@/features/preferences/model";
import { handleUnsubscribe } from "@/features/preferences/public-server";
import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";
import { guardPublicRoute } from "@/lib/public-sender-server";

// CNS-09: the unsubscribe confirmation page (JSON) and a mail program's one-click unsubscribe (RFC 8058) post here. Only a
// POST changes anything; the link in a message opens the confirmation page.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const oneClick = (request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, oneClick ? "text" : "json", () => handleUnsubscribe(request, token), {
    body: { ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT },
    headers: { "Referrer-Policy": "no-referrer" },
  });
}

// Review 6: someone (or a scanner) opening this address gets the confirmation page; nothing is read or written here
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (!PREFERENCES_TOKEN.test(token)) return new Response(null, { status: 404, headers });
  return new Response(null, { status: 303, headers: { ...headers, Location: new URL(unsubscribePagePath(token), request.url).toString() } });
}

import { handleLibraryLinkGo } from "@/features/library-links/public-server";
import { cspNonce } from "@/features/theme/theme";
import { guardPublicRoute } from "@/lib/public-sender-server";

// LIB-02 (owner (293) ב): the page before a link item's site ("אתם עוברים לאתר …"), from the stored link only
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss. The proxy's
  // per-request nonce lets the page's one small script (the back button) run.
  return guardPublicRoute(request, "text", () => handleLibraryLinkGo(request, token, cspNonce(request.headers.get("content-security-policy"))), {
    headers: { "Referrer-Policy": "no-referrer" },
  });
}

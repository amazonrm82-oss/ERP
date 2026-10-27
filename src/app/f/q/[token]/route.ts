import { qrScanResponse } from "@/features/qr-codes/scan-server";
import { cspNonce } from "@/features/theme/theme";

// BIZ-03: a QR code's link. Counts the scan (a number only) and redirects to the code's stored target on this site, or shows
// the page before the code's own external link (owner, 27 October 2026).
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // the proxy's per-request nonce, so the page's one small script (the back button) may run
  return qrScanResponse(token, cspNonce(request.headers.get("content-security-policy")));
}

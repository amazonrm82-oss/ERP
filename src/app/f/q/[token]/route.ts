import { qrScanResponse } from "@/features/qr-codes/scan-server";

// BIZ-03: a QR code's link. Counts the scan (a number only) and redirects to the code's stored target.
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return qrScanResponse(token);
}

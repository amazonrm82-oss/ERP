import { handleOrderPdfDownload } from "@/features/orders/pdf-public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

// ORD-05 PDF (owner, 1 November 2026, answer (1) ב): the customer downloads the stored PDF of the order their link opens
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "text", () => handleOrderPdfDownload(request, token));
}

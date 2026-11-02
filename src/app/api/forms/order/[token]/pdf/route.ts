import { handleOrderPdfDownload } from "@/features/orders/pdf-public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// ORD-05 PDF (owner, 1 November 2026, answer (1) ב): the customer downloads the stored PDF of the order their link opens
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "text");
  if (refused) return refused;
  return handleOrderPdfDownload(request, token);
}

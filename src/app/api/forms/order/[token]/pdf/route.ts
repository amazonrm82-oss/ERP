import { handleOrderPdfDownload } from "@/features/orders/pdf-public-server";

// ORD-05 PDF (owner, 1 November 2026, answer (1) ב): the customer downloads the stored PDF of the order their link opens
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleOrderPdfDownload(request, token);
}

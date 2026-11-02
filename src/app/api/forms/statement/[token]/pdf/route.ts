import { handleStatementPdfDownload } from "@/features/statements/public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// BAL-04 (owner, 1 November 2026, answer (2) א): the customer's statement as a PDF, made for this request and never stored
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "text", { headers: { "Referrer-Policy": "no-referrer" } });
  if (refused) return refused;
  return handleStatementPdfDownload(request, token);
}

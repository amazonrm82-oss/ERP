import { handleStatementPdfDownload } from "@/features/statements/public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

// BAL-04 (owner, 1 November 2026, answer (2) א): the customer's statement as a PDF, made for this request and never stored
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "text", () => handleStatementPdfDownload(request, token), { headers: { "Referrer-Policy": "no-referrer" } });
}

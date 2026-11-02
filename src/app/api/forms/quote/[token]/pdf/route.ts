import { handleQuotePdfDownload } from "@/features/quotes/pdf-public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

// QUO-06 follow-up (owner, 26 October 2026): the customer downloads the stored PDF of the quote their link shows
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "text", () => handleQuotePdfDownload(request, token));
}

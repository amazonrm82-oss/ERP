import { handleQuotePdfDownload } from "@/features/quotes/pdf-public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// QUO-06 follow-up (owner, 26 October 2026): the customer downloads the stored PDF of the quote their link shows
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "text");
  if (refused) return refused;
  return handleQuotePdfDownload(request, token);
}

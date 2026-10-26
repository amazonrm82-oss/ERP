import { handleQuotePdfDownload } from "@/features/quotes/pdf-public-server";

// QUO-06 follow-up (owner, 26 October 2026): the customer downloads the stored PDF of the quote their link shows
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleQuotePdfDownload(request, token);
}

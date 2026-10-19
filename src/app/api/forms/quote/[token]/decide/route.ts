import { handleQuoteDecision } from "@/features/quotes/public-server";

// QUO-09: the customer's page posts the acceptance (with the signature) or the refusal here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleQuoteDecision(request, token);
}

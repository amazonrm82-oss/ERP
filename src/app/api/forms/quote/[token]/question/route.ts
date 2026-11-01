import { handleQuoteQuestion } from "@/features/quotes/public-server";

// QUO-08 (owner, 1 November 2026): the customer's page posts a question to the rep here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleQuoteQuestion(request, token);
}

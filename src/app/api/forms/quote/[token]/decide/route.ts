import { handleQuoteDecision } from "@/features/quotes/public-server";
import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";
import { guardPublicRoute } from "@/lib/public-sender-server";

// QUO-09: the customer's page posts the acceptance (with the signature) or the refusal here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "json", () => handleQuoteDecision(request, token), { body: { ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT } });
}

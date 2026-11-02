import { handleOrderDecision } from "@/features/orders/public-server";
import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";
import { guardPublicRoute } from "@/lib/public-sender-server";

// ORD-05: the customer's page posts the approval (with the signature) or the refusal here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "json", () => handleOrderDecision(request, token), { body: { ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT } });
}

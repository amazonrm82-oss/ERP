import { handleOrderDecision } from "@/features/orders/public-server";

// ORD-05: the customer's page posts the approval (with the signature) or the refusal here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleOrderDecision(request, token);
}

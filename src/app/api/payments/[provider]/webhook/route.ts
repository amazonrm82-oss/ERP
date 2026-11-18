import { paymentWebhook } from "@/features/payment-links/webhook-server";

// LNK-04: the payment provider's webhook, one per provider. Refused (401) before the database unless the provider's
// signature is valid (src/features/payment-links/webhook.ts); the body is never logged.
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  return paymentWebhook(request, provider);
}

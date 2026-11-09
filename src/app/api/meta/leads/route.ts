import { metaVerify, metaWebhook } from "@/features/meta-leads/webhook-server";

// CAP-11: the Meta Lead Ads webhook. GET = Meta's subscription check (the verify token is a secret); POST = new leads,
// refused before the database unless X-Hub-Signature-256 is valid (src/features/meta-leads/webhook.ts).
export async function GET(request: Request) {
  return metaVerify(request);
}

export async function POST(request: Request) {
  return metaWebhook(request);
}

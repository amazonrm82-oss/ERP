import { handleIntake } from "@/features/intake/server";

// Incoming webhook (Zapier, Make, a website plugin...). The token is the secret.
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleIntake(request, token, "webhook");
}

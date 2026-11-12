import { inforuInbound } from "@/features/inforu-callbacks/webhook-server";

// SMS-05: replies to the platform's InforU number (opt-outs, SMS-03). The last segment is the webhook secret (read only by the InforU adapter), checked
// before the body is read.
export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  return inforuInbound(request, secret);
}

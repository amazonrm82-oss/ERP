import { inforuStatus } from "@/features/inforu-callbacks/webhook-server";

// SMS-05: InforU's delivery reports. The last segment is the webhook secret (read only by the InforU adapter), checked before the body is read.
export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  return inforuStatus(request, secret);
}

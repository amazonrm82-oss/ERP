import { inforuStatus } from "@/features/inforu-callbacks/webhook-server";

// SMS-05: InforU's delivery reports. The last segment is the webhook secret (read only by the InforU adapter), checked before the body is read.
export async function POST(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  return inforuStatus(request, secret);
}

// SMS-05c: InforU's push may come as a GET with the parameters in the query; the same route, the secret checked first, and
// a GET reads only the query
export async function GET(request: Request, { params }: { params: Promise<{ secret: string }> }) {
  const { secret } = await params;
  return inforuStatus(request, secret);
}

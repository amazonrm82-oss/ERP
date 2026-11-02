import { handleBooking } from "@/features/booking/public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

// CAL-10: one booking from the public booking page (public prefix /api/forms/ in the proxy).
export async function POST(request: Request, { params }: Props) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "json");
  if (refused) return refused;
  return handleBooking(request, token);
}

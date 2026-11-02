import { handleBookingManage } from "@/features/booking/public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

type Props = { params: Promise<{ token: string }> };

// CAL-10b: a cancel or a change through the customer's personal link (public prefix /api/forms/ in the proxy).
export async function POST(request: Request, { params }: Props) {
  const { token } = await params;
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "json", () => handleBookingManage(request, token));
}

import { handleBooking } from "@/features/booking/public-server";

type Props = { params: Promise<{ token: string }> };

// CAL-10: one booking from the public booking page (public prefix /api/forms/ in the proxy).
export async function POST(request: Request, { params }: Props) {
  const { token } = await params;
  return handleBooking(request, token);
}

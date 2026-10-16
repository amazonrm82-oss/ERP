import { handleBookingManage } from "@/features/booking/public-server";

type Props = { params: Promise<{ token: string }> };

// CAL-10b: a cancel or a change through the customer's personal link (public prefix /api/forms/ in the proxy).
export async function POST(request: Request, { params }: Props) {
  const { token } = await params;
  return handleBookingManage(request, token);
}

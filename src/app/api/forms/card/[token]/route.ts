import { handleCardSubmit } from "@/features/business-cards/public-server";

// BIZ-02: the business card's "leave details" form posts here (same-origin; the card page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleCardSubmit(request, token);
}

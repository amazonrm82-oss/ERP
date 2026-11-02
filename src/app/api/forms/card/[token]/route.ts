import { handleCardSubmit } from "@/features/business-cards/public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// BIZ-02: the business card's "leave details" form posts here (same-origin; the card page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "json");
  if (refused) return refused;
  return handleCardSubmit(request, token);
}

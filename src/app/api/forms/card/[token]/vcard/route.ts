import { handleCardVCard } from "@/features/business-cards/public-server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// BIZ-02: "save to contacts": the card as a .vcf file, with the fields the rep marked public
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "text");
  if (refused) return refused;
  return handleCardVCard(request, token);
}

import { handleCardVCard } from "@/features/business-cards/public-server";

// BIZ-02: "save to contacts": the card as a .vcf file, with the fields the rep marked public
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleCardVCard(request, token);
}

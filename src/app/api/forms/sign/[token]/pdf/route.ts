import { handleSignaturePdfDownload } from "@/features/signatures/public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

// SGN-02, owner (223) ב: the customer downloads the signed PDF from the signing page, after signing
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "text", () => handleSignaturePdfDownload(request, token));
}

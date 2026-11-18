import { handleDocumentFileDownload } from "@/features/document-links/public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

// DOC-15: the customer's download of the document's current PDF (public.document_public_file only)
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "text", () => handleDocumentFileDownload(request, token), { headers: { "Referrer-Policy": "no-referrer" } });
}

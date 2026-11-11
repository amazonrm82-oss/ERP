import { handleLibraryFileDownload } from "@/features/library-links/public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

// LIB-02: the file of a library item sent by a tracked link, through a one-minute signed link
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "text", () => handleLibraryFileDownload(request, token), { headers: { "Referrer-Policy": "no-referrer" } });
}

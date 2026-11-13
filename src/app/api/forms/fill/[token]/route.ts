import { handlePrefillSubmit } from "@/features/prefill-links/public-server";
import { guardPublicRoute } from "@/lib/public-sender-server";

// BIZ-05: the prefill form's page posts the answers here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02: the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "json", () => handlePrefillSubmit(request, token), { headers: { "Referrer-Policy": "no-referrer" } });
}

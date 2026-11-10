import { handlePreferencesSubmit } from "@/features/preferences/public-server";
import { RATE_LIMITED_TEXT } from "@/lib/public-rate-limit";
import { guardPublicRoute } from "@/lib/public-sender-server";

// CNS-10: the customer's preferences page posts its choices here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב, (42) ד): the shared per-sender limit of the secret-link pages first; a "not found" counts one miss
  return guardPublicRoute(request, "json", () => handlePreferencesSubmit(request, token), {
    body: { ok: false, status: "rate_limited", message: RATE_LIMITED_TEXT },
    headers: { "Referrer-Policy": "no-referrer" },
  });
}

import { CORS_HEADERS, handleIntake, preflight } from "@/features/intake/server";
import { refusePublicRequest } from "@/lib/public-sender-server";

// Public web forms post here: the hosted form at /f/<token>, or a form on the
// customer's own site. The token is public (it is in the embed code).
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // OPS-02 (owner (40) ב): the shared per-sender limit first, before the token is looked up
  const refused = await refusePublicRequest(request, "json", { headers: CORS_HEADERS });
  if (refused) return refused;
  return handleIntake(request, token, "form");
}

export function OPTIONS() {
  return preflight();
}

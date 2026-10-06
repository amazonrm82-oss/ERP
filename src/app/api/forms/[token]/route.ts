import { handleIntake, preflight } from "@/features/intake/server";

// Public web forms post here: the hosted form at /f/<token>, or a form on the
// customer's own site. The token is public (it is in the embed code).
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleIntake(request, token, "form");
}

export function OPTIONS() {
  return preflight();
}

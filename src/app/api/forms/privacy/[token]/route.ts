import { handlePrivacySubmit } from "@/features/privacy-requests/public-server";

// PRK-02: the public privacy-request form posts here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handlePrivacySubmit(request, token);
}

import { handleBusinessPageSubmit } from "@/features/business-page/public-server";

// BIZ-01: the business page's contact form posts here (same-origin; the page's own script)
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleBusinessPageSubmit(request, token);
}

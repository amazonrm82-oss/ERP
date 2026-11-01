import { handleStatementPdfDownload } from "@/features/statements/public-server";

// BAL-04 (owner, 1 November 2026, answer (2) א): the customer's statement as a PDF, made for this request and never stored
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return handleStatementPdfDownload(request, token);
}

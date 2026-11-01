import { handleStaffStatementPdf } from "@/features/statements/pdf-server";

// BAL-04 (owner, 1 November 2026, answer (2) א): a customer's statement as a PDF for staff, made with the user's session for
// this request and never stored
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string; kind: string; id: string }> }) {
  const { orgId, kind, id } = await params;
  return handleStaffStatementPdf(request, orgId, kind, id);
}

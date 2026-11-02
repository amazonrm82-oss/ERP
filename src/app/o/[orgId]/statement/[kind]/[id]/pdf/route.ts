import { handleStaffStatementPdf } from "@/features/statements/pdf-server";

// BAL-04 (owner, 1 and 2 November 2026): a customer's statement as a PDF for staff, the customer's document read with the
// user's session for this request and never stored
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string; kind: string; id: string }> }) {
  const { orgId, kind, id } = await params;
  return handleStaffStatementPdf(orgId, kind, id);
}

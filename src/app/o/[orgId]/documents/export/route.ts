import { exportDocuments } from "@/features/documents/export-server";

// The accounting documents list as CSV or Excel, with its filters or the picked rows (LST-09).
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return exportDocuments(request, orgId);
}

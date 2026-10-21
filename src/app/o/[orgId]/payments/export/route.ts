import { exportPayments } from "@/features/payments/export-server";

// The payments list as CSV or Excel, with its filters or the picked rows (LST-09).
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return exportPayments(request, orgId);
}

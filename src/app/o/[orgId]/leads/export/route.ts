import { exportList } from "@/features/list-export/server";

// The list as CSV or Excel, with its filters (LST-08).
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return exportList(request, orgId, "lead");
}

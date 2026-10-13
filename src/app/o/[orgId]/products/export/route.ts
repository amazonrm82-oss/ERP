import { exportProducts } from "@/features/products/export-server";

// The product list as CSV or Excel, with its filters (PRD-05).
export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return exportProducts(request, orgId);
}

import { buildFullExport } from "@/features/imports/export";
import { getOrgContext } from "@/features/shell/queries";
import { zoneDate } from "@/lib/format";

// Full export (SPEC 12.4): the account owner downloads everything as a ZIP of CSV files.
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role } = await getOrgContext(orgId);
  if (role !== "owner") {
    return new Response("ייצוא מלא זמין לבעל החשבון בלבד.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const zip = await buildFullExport(orgId);
  return new Response(zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="crm-export-${zoneDate(new Date())}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

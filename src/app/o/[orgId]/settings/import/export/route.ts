import { buildFullExport } from "@/features/imports/export";
import { getOrgContextForOwner } from "@/features/shell/queries";
import { zoneDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

// Full export (SPEC 12.4): the account owner downloads everything as a ZIP of CSV files, in every
// state of the business (owner, 13 October 2026).
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  // also while the business is read-only or closed until payment: the owner's data stays theirs (BIL-09)
  const { role } = await getOrgContextForOwner(orgId);
  if (role !== "owner") {
    return new Response("ייצוא מלא זמין לבעלים של העסק בלבד.", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const { zip, rows } = await buildFullExport(orgId);
  // IMP-02: written to the audit log before the file is handed over; no log, no file
  const supabase = await createClient();
  const { error } = await supabase.rpc("log_export", { p_org: orgId, p_kind: "full", p_report: null, p_rows: rows });
  if (error) {
    return new Response("לא הצלחנו להכין את הקובץ. נסו שוב.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(zip as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="crm-export-${zoneDate(new Date())}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

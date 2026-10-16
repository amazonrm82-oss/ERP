import { personZipStream } from "@/features/privacy-export/build";
import { collectPerson, readStoredFile } from "@/features/privacy-export/collect";
import { isAdminRole } from "@/features/settings/permissions";
import { getOrgContextForOwner } from "@/features/shell/queries";
import { zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

const text = (body: string, status: number) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

// PRV-02: everything the business holds about one lead or contact, in one ZIP, for owners and admins (also while the
// business is closed until payment, like the full export). Read with the user's session; logged before any byte is sent.
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string; kind: string; id: string }> }) {
  const { orgId, kind, id } = await params;
  if (!isUuid(orgId) || !isUuid(id) || (kind !== "lead" && kind !== "contact")) return text("לא נמצא", 404);
  const context = await getOrgContextForOwner(orgId);
  if (!isAdminRole(context.role)) return text("ייצוא המידע על אדם זמין לבעלים ולמנהלי מערכת בלבד.", 403);

  let person;
  try {
    person = await collectPerson(orgId, kind, id, context.user.id);
  } catch {
    return text("לא הצלחנו להכין את הקובץ. נסו שוב.", 500);
  }
  if (!person) return text("הרשומה לא נמצאה.", 404);

  // written to the audit log before the file is handed over; no log, no file
  const supabase = await createClient();
  const { error } = await supabase.rpc("log_person_export", { p_org: orgId, p_kind: kind, p_id: id, p_rows: person.rows, p_files: person.files.length });
  if (error) return text("לא הצלחנו להכין את הקובץ. נסו שוב.", 500);

  // streamed: the files are read one at a time while the ZIP goes out, never held whole (a buffered answer is capped
  // at about 4.5 MB on Vercel)
  return new Response(personZipStream(person.data, person.files, (path) => readStoredFile(supabase, path)), {
    headers: {
      "Content-Type": "application/zip",
      // no name in the file name: it lands in the downloads folder and the browser's history
      "Content-Disposition": `attachment; filename="person-${kind}-${zoneDate(new Date(), context.org.timeZone)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}

import { NextResponse } from "next/server";

import { JOB_FILES_BUCKET } from "@/features/background/rules";
import { sessionCheck } from "@/lib/auth";
import { zoneDate } from "@/lib/format";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ orgId: string; requestId: string }> };

/**
 * IMP-04: the background export's file. The order is read with the user's own session (own rows only), and the
 * browser goes to a one-minute signed link, which Storage makes only while the bucket's policy lets this user read
 * the file: their own export, still the owner, not expired.
 */
export async function GET(_request: Request, { params }: Context) {
  const { orgId, requestId } = await params;
  if (!isUuid(orgId) || !isUuid(requestId)) return new NextResponse("לא נמצא", { status: 404 });
  const session = await sessionCheck();
  if (!session.ok) {
    return session.unavailable
      ? new NextResponse(session.message, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } })
      : new NextResponse("לא נמצא", { status: 404 });
  }
  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("background_requests")
    .select("kind, status, file_path, file_expires_at")
    .eq("organization_id", orgId)
    .eq("id", requestId)
    .maybeSingle();
  if (error) return new NextResponse("משהו השתבש. נסו שוב בעוד רגע.", { status: 500 });
  if (!row || row.kind !== "export" || row.status !== "done" || !row.file_path || !row.file_expires_at || Date.parse(row.file_expires_at) <= Date.now()) {
    return new NextResponse("הקובץ לא נמצא, או שעברו 7 הימים שבהם הוא נשמר.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const { data, error: linkError } = await supabase.storage
    .from(JOB_FILES_BUCKET)
    .createSignedUrl(row.file_path, 60, { download: `crm-export-${zoneDate(new Date())}.zip` });
  if (linkError || !data) return new NextResponse("לא נמצא", { status: 404 });
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "Cache-Control": "no-store" } });
}

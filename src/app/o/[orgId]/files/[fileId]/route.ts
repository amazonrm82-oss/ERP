import { NextResponse, type NextRequest } from "next/server";

import { FILES_BUCKET } from "@/features/files/types";
import { sessionCheck } from "@/lib/auth";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ orgId: string; fileId: string }> };

/**
 * Opens a file: reads its row with the user's session (RLS decides), then sends
 * the browser to a one-minute signed link on the storage domain. Images and PDFs
 * open in the browser (?view=1); everything else downloads.
 */
export async function GET(request: NextRequest, { params }: Context) {
  const { orgId, fileId } = await params;
  if (!isUuid(orgId) || !isUuid(fileId)) {
    return new NextResponse("לא נמצא", { status: 404 });
  }
  const session = await sessionCheck();
  if (!session.ok) {
    // FXC-10: the sign-in service did not answer; that is not "not found"
    return session.unavailable
      ? new NextResponse(session.message, { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "5" } })
      : new NextResponse("לא נמצא", { status: 404 });
  }
  const supabase = await createClient();
  const { data: file, error: fileError } = await supabase
    .from("files")
    .select("name, mime_type, storage_path")
    .eq("organization_id", orgId)
    .eq("id", fileId)
    .maybeSingle();
  if (fileError) return new NextResponse("משהו השתבש. נסו שוב בעוד רגע.", { status: 500 });
  if (!file) return new NextResponse("לא נמצא", { status: 404 });
  const view = request.nextUrl.searchParams.get("view") === "1" && (file.mime_type.startsWith("image/") || file.mime_type === "application/pdf");
  const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrl(file.storage_path, 60, view ? undefined : { download: file.name });
  if (error || !data) return new NextResponse("לא נמצא", { status: 404 });
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "Cache-Control": "no-store" } });
}

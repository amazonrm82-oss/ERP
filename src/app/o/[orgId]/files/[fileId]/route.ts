import { NextResponse, type NextRequest } from "next/server";

import { FILES_BUCKET, opensInBrowser } from "@/features/files/types";
import { DAMAGED_PDF_MESSAGE, matchesFingerprint, pdfHeaders } from "@/features/quotes/pdf-fingerprint";
import { sessionCheck } from "@/lib/auth";
import { SUPPORT_LINE } from "@/lib/support";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ orgId: string; fileId: string }> };

/**
 * Opens a file: reads its row with the user's session (RLS decides), then sends
 * the browser to a one-minute signed link on the storage domain. Images and PDFs
 * open in the browser (?view=1); everything else downloads, SVG included (FXS-07).
 * An upload that has not been confirmed is not opened.
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
    .select("name, mime_type, storage_path, unconfirmed_since, quote_id, sha256")
    .eq("organization_id", orgId)
    .eq("id", fileId)
    .maybeSingle();
  if (fileError) return new NextResponse("משהו השתבש. נסו שוב בעוד רגע.", { status: 500 });
  if (!file || file.unconfirmed_since !== null) return new NextResponse("לא נמצא", { status: 404 });
  const view = request.nextUrl.searchParams.get("view") === "1" && opensInBrowser(file.mime_type);
  // QUO-06 follow-up (owner, 26 October 2026): a quote's PDF is served only after its bytes match the SHA-256 the server
  // kept when it wrote the file; never through a signed link, so nothing else can be served in its place. A PDF kept before
  // the fingerprint existed has none and still opens as before.
  if (file.quote_id && file.sha256) {
    const object = await supabase.storage.from(FILES_BUCKET).download(file.storage_path);
    if (object.error || !object.data) return new NextResponse("לא נמצא", { status: 404 });
    const bytes = new Uint8Array(await object.data.arrayBuffer());
    if (!matchesFingerprint(bytes, file.sha256)) {
      // review M1: reported and logged, never replaced automatically
      console.error(`[QUO-06] stored quote PDF failed its SHA-256 check: org ${orgId}, file ${fileId}`);
      return new NextResponse(`${DAMAGED_PDF_MESSAGE} (${SUPPORT_LINE}).`, {
        status: 409,
        headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new NextResponse(bytes, { status: 200, headers: pdfHeaders(file.name, bytes.length, view) });
  }
  const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrl(file.storage_path, 60, view ? undefined : { download: file.name });
  if (error || !data) return new NextResponse("לא נמצא", { status: 404 });
  return NextResponse.redirect(data.signedUrl, { status: 302, headers: { "Cache-Control": "no-store" } });
}

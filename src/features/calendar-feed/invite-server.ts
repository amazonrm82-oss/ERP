import "server-only";

import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { isUuid } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { buildIcs, icsDisposition } from "./ics";
import { inviteOrganizer } from "./organizer";

/**
 * CAL-07: one meeting as an invite file (.ics) to send to the customer, read
 * with the user's session (RLS decides; no service role). METHOD:PUBLISH, the
 * business as the organizer's name. RFC 5545 requires an address with it: the
 * meeting organizer's own (profiles, read with the user's session); when it is
 * not visible, the file has no ORGANIZER. When the business has an email in its
 * document details (TAX-02, read with the user's session), that address is the
 * ORGANIZER instead, named "<organizer>, <business>" (owner, 13 October 2026). Never the downloader's address (a
 * support session downloads too). Title, times, place and video link only:
 * never the description, the outcome or the team.
 */
export async function meetingInviteResponse(orgId: string, meetingId: string): Promise<Response> {
  if (!isUuid(meetingId)) {
    return new Response("not found", { status: 404 });
  }
  const { org } = await getOrgContext(orgId);
  const supabase = await createClient();
  const meeting = must(
    await supabase
      .from("meetings")
      .select("id, title, starts_at, ends_at, location, video_url, status, updated_at, owner_id")
      .eq("organization_id", orgId)
      .eq("id", meetingId)
      .maybeSingle(),
    "meeting",
  );
  if (!meeting) {
    return new Response("הפגישה לא נמצאה.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const [owner, details] = await Promise.all([
    meeting.owner_id
      ? supabase.from("profiles").select("full_name, email").eq("id", meeting.owner_id).maybeSingle().then((res) => must(res, "meeting organizer"))
      : null,
    supabase.from("org_document_settings").select("email").eq("organization_id", orgId).maybeSingle().then((res) => must(res, "business email")),
  ]);
  const body = buildIcs({
    events: [
      {
        id: meeting.id,
        title: meeting.title,
        startsAt: meeting.starts_at,
        endsAt: meeting.ends_at,
        location: meeting.location,
        videoUrl: meeting.video_url,
        status: meeting.status,
        updatedAt: meeting.updated_at,
      },
    ],
    organizer: inviteOrganizer({
      businessName: org.name,
      businessEmail: details?.email ?? null,
      organizerName: owner?.full_name ?? null,
      organizerEmail: owner?.email ?? null,
    }),
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8; method=PUBLISH",
      "Content-Disposition": icsDisposition(meeting.title),
      "Cache-Control": "no-store",
    },
  });
}

import { meetingInviteResponse } from "@/features/calendar-feed/invite-server";

// CAL-07: a meeting's invite file (.ics) for the customer, read with the user's session.
export async function GET(_request: Request, { params }: { params: Promise<{ orgId: string; meetingId: string }> }) {
  const { orgId, meetingId } = await params;
  return meetingInviteResponse(orgId, meetingId);
}

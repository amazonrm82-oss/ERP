import { calendarFeedResponse } from "@/features/calendar-feed/feed-server";

// CAL-07: the personal calendar feed, /api/calendar-feed/<token>.ics. No session: the
// secret token in the path is the key (see feed-server.ts).
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  return calendarFeedResponse(file);
}

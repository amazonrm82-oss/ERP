import "server-only";

import { SUBJECT_COLUMN, type TimelineSubject } from "@/features/activities/schema";
import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type MeetingItem = {
  id: string;
  title: string;
  meetingType: string;
  // CAL-08: the business's meeting type; null = none
  meetingTypeId: string | null;
  // CAL-09: its place in a weekly series; null = a single meeting
  seriesIndex: number | null;
  startsAt: string;
  endsAt: string;
  location: string | null;
  videoUrl: string | null;
  description: string | null;
  status: string;
  outcome: string | null;
  // CAL-06: minutes before the start; null = no reminder
  reminderMinutes: number | null;
  // CAL-10: the meeting's own free time before and after, in minutes
  bufferBefore: number;
  bufferAfter: number;
  ownerId: string | null;
  ownerName: string | null;
  participants: { userId: string; name: string }[];
};

// a record's card shows this many; the calendar (CAL-02) shows the rest
const RECORD_LIMIT = 50;

/** The meetings of one lead, contact, company or deal that the user may see (RLS decides). */
export async function listRecordMeetings(orgId: string, subject: TimelineSubject): Promise<MeetingItem[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("meetings")
      .select("id, title, meeting_type, meeting_type_id, series_index, starts_at, ends_at, location, video_url, description, status, outcome, owner_id, reminder_minutes, buffer_before_minutes, buffer_after_minutes")
      .eq("organization_id", orgId)
      .eq(SUBJECT_COLUMN[subject.kind], subject.id)
      .order("starts_at", { ascending: false })
      .limit(RECORD_LIMIT),
    "meetings",
  );
  if (rows.length === 0) {
    return [];
  }
  const participants = must(
    await supabase
      .from("meeting_participants")
      .select("meeting_id, user_id")
      .eq("organization_id", orgId)
      .in(
        "meeting_id",
        rows.map((row) => row.id),
      ),
    "meeting participants",
  );
  const names = await getUserNames([...rows.map((row) => row.owner_id), ...participants.map((p) => p.user_id)]);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    meetingType: row.meeting_type,
    meetingTypeId: row.meeting_type_id,
    seriesIndex: row.series_index,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    location: row.location,
    videoUrl: row.video_url,
    description: row.description,
    status: row.status,
    outcome: row.outcome,
    reminderMinutes: row.reminder_minutes,
    bufferBefore: row.buffer_before_minutes,
    bufferAfter: row.buffer_after_minutes,
    ownerId: row.owner_id,
    ownerName: row.owner_id ? (names.get(row.owner_id) ?? null) : null,
    participants: participants
      .filter((p) => p.meeting_id === row.id)
      .map((p) => ({ userId: p.user_id, name: names.get(p.user_id) ?? "משתמש" })),
  }));
}

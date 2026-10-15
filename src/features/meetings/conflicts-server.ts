import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { calendarSettingsFromRow } from "@/features/calendar-days/holidays";
import { isTimeZone, readWorkingHours } from "@/features/profile/working-hours";
import type { Database } from "@/lib/database.types";

import { conflictReport, type ConflictPerson, type ConflictReport, type Span } from "./conflicts";

type Client = SupabaseClient<Database>;

type Check = {
  span: Span;
  // the organizer first, then the participants
  userIds: string[];
  // the meeting being edited or moved
  excludeId?: string | null;
  // the organization's zone
  timeZone: string;
  // CAL-08: the meeting's type, whose buffers widen the time that must be free
  typeId?: string | null;
};

/** The span with minutes added before and after. */
function widened(span: Span, before: number, after: number): Span {
  return {
    startsAt: new Date(Date.parse(span.startsAt) - before * 60_000).toISOString(),
    endsAt: new Date(Date.parse(span.endsAt) + after * 60_000).toISOString(),
  };
}

/**
 * What to warn about before a meeting is saved (CAL-05), or null. Busy times
 * come from public.meeting_busy(), which also counts meetings the user may not
 * see but names (id, title) only the ones they may read; names, working hours
 * and rest days are read with the user's session, so RLS decides.
 * The check is a warning: when it cannot be made (a read fails) it logs the
 * error, answers null, and the meeting is saved as before.
 */
export async function meetingConflicts(supabase: Client, orgId: string, { span, userIds, excludeId, timeZone, typeId }: Check): Promise<ConflictReport | null> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return null;

  // CAL-08: the type's buffers, read with the user's session (members read the list); a type
  // deleted meanwhile has none
  let busySpan = span;
  if (typeId) {
    const { data: type, error } = await supabase
      .from("meeting_types")
      .select("buffer_before_minutes, buffer_after_minutes")
      .eq("organization_id", orgId)
      .eq("id", typeId)
      .maybeSingle();
    if (error) {
      console.error("[CAL-05 meeting conflicts] check skipped, a read failed:", error.code, error.message);
      return null;
    }
    if (type) busySpan = widened(span, type.buffer_before_minutes, type.buffer_after_minutes);
  }

  const [busyRead, profilesRead, settingsRead] = await Promise.all([
    supabase.rpc("meeting_busy", { p_org: orgId, p_users: ids, p_from: busySpan.startsAt, p_to: busySpan.endsAt, p_exclude: excludeId ?? null }),
    supabase.from("profiles").select("id, full_name, email, working_hours, timezone").in("id", ids),
    supabase.from("org_calendar_settings").select("rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions").eq("organization_id", orgId).maybeSingle(),
  ]);
  // advisory: a check that cannot be made must not block the save, but it must show in the logs
  const readError = busyRead.error ?? profilesRead.error ?? settingsRead.error;
  if (readError) {
    console.error("[CAL-05 meeting conflicts] check skipped, a read failed:", readError.code, readError.message);
    return null;
  }

  const profiles = new Map((profilesRead.data ?? []).map((row) => [row.id, row]));
  const people: ConflictPerson[] = ids.map((id) => {
    const profile = profiles.get(id);
    const zone = profile?.timezone;
    return {
      userId: id,
      name: profile?.full_name?.trim() || profile?.email || "משתמש",
      hours: profile ? readWorkingHours(profile.working_hours) : null,
      timeZone: isTimeZone(zone) ? zone : timeZone,
    };
  });

  const settings = calendarSettingsFromRow(settingsRead.data);

  return conflictReport({
    span,
    busySpan,
    people,
    busy: (busyRead.data ?? []).map((r) => ({
      userId: r.user_id,
      meetingId: r.meeting_id,
      title: r.title,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      busyFrom: r.busy_from,
      busyTo: r.busy_to,
    })),
    excludeId,
    settings,
    timeZone,
  });
}

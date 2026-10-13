import "server-only";

import { readWorkingHours, type WorkingHours } from "@/features/profile/working-hours";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { wallClock } from "./in-hours";

export type LeaveItem = { id: string; startsOn: string; endsOn: string };

export type MemberHours = {
  // null: the business's zone
  timeZone: string | null;
  // null: the business's hours apply
  hours: WorkingHours | null;
  // current and coming leaves, earliest first
  leaves: LeaveItem[];
};

/** The business's own weekly hours; null while it has not set any (no hours limit). */
export async function getOrgHours(orgId: string): Promise<WorkingHours | null> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("org_calendar_settings").select("working_hours").eq("organization_id", orgId).maybeSingle(),
    "org working hours",
  );
  return readWorkingHours(row?.working_hours ?? null);
}

/** A member's hours, zone and the leaves that end from yesterday on (RLS: colleagues read them). */
export async function getMemberHours(orgId: string, userId: string, orgTimeZone: string): Promise<MemberHours> {
  // any zone's today is within a day of the business's
  const fromDay = wallClock(new Date(Date.now() - 86_400_000), orgTimeZone).date;
  const supabase = await createClient();
  const [profile, leaves] = await Promise.all([
    supabase.from("profiles").select("working_hours, timezone").eq("id", userId).maybeSingle(),
    supabase
      .from("member_leaves")
      .select("id, starts_on, ends_on")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .gte("ends_on", fromDay)
      .order("starts_on")
      .order("id")
      .limit(100),
  ]);
  const row = must(profile, "member hours");
  return {
    timeZone: row?.timezone ?? null,
    hours: readWorkingHours(row?.working_hours ?? null),
    leaves: must(leaves, "member leaves").map((l) => ({ id: l.id, startsOn: l.starts_on, endsOn: l.ends_on })),
  };
}

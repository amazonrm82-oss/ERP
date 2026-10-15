import "server-only";

import { managedTeams } from "@/features/goals/grid";
import { getUserNames } from "@/features/shell/queries";
import type { BookingQuestion } from "@/lib/database.types";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { readQuestions } from "./schema";

/** A booking page as the settings page shows it (CAL-10). */
export type BookingPageItem = {
  id: string;
  token: string;
  userId: string;
  repName: string;
  title: string;
  intro: string | null;
  meetingTypeId: string | null;
  meetingTypeName: string | null;
  // the type is gone or hidden: the public page answers "not found"
  meetingTypeUsable: boolean;
  sourceId: string | null;
  minNoticeMinutes: number;
  maxDaysAhead: number;
  slotStepMinutes: number;
  questions: BookingQuestion[];
  isActive: boolean;
};

/** The pages the user may see (RLS: their own; owners and admins all; a team manager their people's), newest first. */
export async function listBookingPages(orgId: string): Promise<BookingPageItem[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("booking_pages")
      .select("id, token, user_id, title, intro, meeting_type_id, source_id, min_notice_minutes, max_days_ahead, slot_step_minutes, questions, is_active, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: true }),
    "booking pages",
  );
  const typeIds = [...new Set(rows.map((r) => r.meeting_type_id).filter((id): id is string => id !== null))];
  const [types, names] = await Promise.all([
    typeIds.length > 0
      ? supabase.from("meeting_types").select("id, name, is_active").eq("organization_id", orgId).in("id", typeIds).then((r) => must(r, "booking page types"))
      : Promise.resolve([]),
    getUserNames(rows.map((r) => r.user_id)),
  ]);
  const typeById = new Map(types.map((t) => [t.id, t]));
  return rows.map((row) => {
    const type = row.meeting_type_id ? typeById.get(row.meeting_type_id) : undefined;
    return {
      id: row.id,
      token: row.token,
      userId: row.user_id,
      repName: names.get(row.user_id) ?? "משתמש",
      title: row.title,
      intro: row.intro,
      meetingTypeId: row.meeting_type_id,
      meetingTypeName: type?.name ?? null,
      meetingTypeUsable: Boolean(type?.is_active),
      sourceId: row.source_id,
      minNoticeMinutes: row.min_notice_minutes,
      maxDaysAhead: row.max_days_ahead,
      slotStepMinutes: row.slot_step_minutes,
      questions: readQuestions(row.questions),
      isActive: row.is_active,
    };
  });
}

/** Whether the rep (or, without one, the business) has working hours: without them the page offers no times. */
export async function repHasHours(orgId: string, userIds: string[]): Promise<{ business: boolean; people: Set<string> }> {
  const supabase = await createClient();
  const [settings, profiles] = await Promise.all([
    supabase.from("org_calendar_settings").select("working_hours").eq("organization_id", orgId).maybeSingle(),
    userIds.length > 0 ? supabase.from("profiles").select("id, working_hours").in("id", userIds) : Promise.resolve({ data: [], error: null }),
  ]);
  const business = must(settings, "calendar settings")?.working_hours != null;
  const people = new Set(must(profiles, "profiles hours").filter((p) => p.working_hours != null).map((p) => p.id));
  return { business, people };
}

/**
 * The people a team manager may make and manage pages for: `member`-role people of the teams they manage or a team
 * below (the rule of app.booking_manages_rep; the database decides either way).
 */
export async function managedBookingReps(orgId: string, userId: string): Promise<Set<string>> {
  const supabase = await createClient();
  const [teams, members] = await Promise.all([
    supabase.from("teams").select("id, parent_team_id").eq("organization_id", orgId),
    supabase.from("team_members").select("team_id, user_id, is_manager").eq("organization_id", orgId),
  ]);
  const memberRows = must(members, "team members");
  const managed = managedTeams(userId, must(teams, "teams"), memberRows);
  return new Set(memberRows.filter((m) => managed.has(m.team_id) && m.user_id !== userId).map((m) => m.user_id));
}

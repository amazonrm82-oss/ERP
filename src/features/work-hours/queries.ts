import "server-only";

import { readWorkingHours, type WorkingHours } from "@/features/profile/working-hours";
import { listMembers } from "@/features/settings/queries";
import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { wallClock } from "./in-hours";
import { parseLeaveKind, type LeaveKind } from "./leave";

export type LeaveItem = {
  id: string;
  startsOn: string;
  endsOn: string;
  // HEB-08: null = a plain leave
  kind: LeaveKind | null;
  deputyId: string | null;
  deputyName: string | null;
};

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
      .select("id, starts_on, ends_on, kind, deputy_id")
      .eq("organization_id", orgId)
      .eq("user_id", userId)
      .gte("ends_on", fromDay)
      .order("starts_on")
      .order("id")
      .limit(100),
  ]);
  const row = must(profile, "member hours");
  const leaveRows = must(leaves, "member leaves");
  const names = await getUserNames(leaveRows.map((l) => l.deputy_id));
  return {
    timeZone: row?.timezone ?? null,
    hours: readWorkingHours(row?.working_hours ?? null),
    leaves: leaveRows.map((l) => ({
      id: l.id,
      startsOn: l.starts_on,
      endsOn: l.ends_on,
      kind: parseLeaveKind(l.kind),
      deputyId: l.deputy_id,
      deputyName: l.deputy_id ? (names.get(l.deputy_id) ?? null) : null,
    })),
  };
}

export type CurrentAbsence = { userId: string; kind: LeaveKind | null; endsOn: string; deputyId: string | null; deputyName: string | null };

/**
 * HEB-08: who is away today (the business's date), with the deputy, for the team
 * screen and the tasks list. Read with the user's session (members read leaves).
 */
export async function getCurrentAbsences(orgId: string, orgTimeZone: string): Promise<Map<string, CurrentAbsence>> {
  const today = wallClock(new Date(), orgTimeZone).date;
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("member_leaves")
      .select("user_id, kind, ends_on, deputy_id, starts_on")
      .eq("organization_id", orgId)
      .lte("starts_on", today)
      .gte("ends_on", today)
      .order("starts_on", { ascending: false })
      .order("id")
      .limit(1000),
    "current absences",
  );
  const names = await getUserNames(rows.map((r) => r.deputy_id));
  const absences = new Map<string, CurrentAbsence>();
  for (const r of rows) {
    const current = absences.get(r.user_id);
    // one per person: a leave with a deputy wins (as app.deputy_for picks it)
    if (current && (current.deputyId || !r.deputy_id)) continue;
    absences.set(r.user_id, {
      userId: r.user_id,
      kind: parseLeaveKind(r.kind),
      endsOn: r.ends_on,
      deputyId: r.deputy_id,
      deputyName: r.deputy_id ? (names.get(r.deputy_id) ?? null) : null,
    });
  }
  return absences;
}

/** HEB-08: who may stand in for a member: active members who are not viewers, the member left out. */
export async function getDeputyOptions(orgId: string, userId: string): Promise<{ userId: string; name: string }[]> {
  const members = await listMembers(orgId);
  return members
    .filter((m) => m.status === "active" && m.role !== "viewer" && m.userId !== userId)
    .map((m) => ({ userId: m.userId, name: m.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "he"));
}

/**
 * HEB-08: the active forms whose leads go to this member as their fixed owner, by name.
 * Read with the user's session: forms are visible to owners and admins only, so for
 * anyone else this is empty (and the leave form shows no warning).
 */
export async function getFixedOwnerForms(orgId: string, userId: string): Promise<string[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("forms")
      .select("name")
      .eq("organization_id", orgId)
      .eq("owner_id", userId)
      .eq("assign_mode", "owner")
      .eq("is_active", true)
      .order("name")
      .limit(50),
    "fixed owner forms",
  );
  return rows.map((r) => r.name);
}

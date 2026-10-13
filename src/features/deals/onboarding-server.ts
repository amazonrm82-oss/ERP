import "server-only";

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { calendarSettingsFromRow, type CalendarSettings } from "@/features/calendar-days/holidays";
import type { Database } from "@/lib/database.types";
import { zonedIso } from "@/lib/format";

import { ONBOARDING_PREFIX, onboardingDueDate, onboardingTitle } from "./close-window";

type Supabase = SupabaseClient<Database>;

/**
 * DEAL-04: does the deal already have an open onboarding task (ONBOARDING_PREFIX).
 * Read with the user's session, so a task the user may not see does not count.
 */
export async function openOnboardingTask(supabase: Supabase, orgId: string, dealId: string): Promise<{ error: PostgrestError } | { open: boolean }> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id")
    .eq("organization_id", orgId)
    .eq("deal_id", dealId)
    .eq("status", "open")
    .is("deleted_at", null)
    .like("title", `${ONBOARDING_PREFIX}%`)
    .limit(1);
  return error ? { error } : { open: data.length > 0 };
}

/** The organization's rest days (CAL-03), read with the user's session; the defaults while none are saved. */
export async function readCalendarSettings(supabase: Supabase, orgId: string): Promise<{ error: PostgrestError } | { calendar: CalendarSettings }> {
  const { data, error } = await supabase
    .from("org_calendar_settings")
    .select("rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions")
    .eq("organization_id", orgId)
    .maybeSingle();
  return error ? { error } : { calendar: calendarSettingsFromRow(data) };
}

export type OnboardingTask = {
  dealId: string;
  contactId: string | null;
  companyId: string | null;
  title: string;
  // a calendar day in the organization's zone, or none
  dueDate: string | null;
  // none: the user (database default)
  ownerId: string | null;
};

/**
 * Adds the onboarding task of a won deal, with the user's session. It is linked
 * to the deal, and to its contact and company only when the user can read them
 * (tasks_insert, migration 0074).
 */
export async function insertOnboardingTask(supabase: Supabase, orgId: string, task: OnboardingTask, timeZone: string): Promise<PostgrestError | null> {
  const [contact, company] = await Promise.all([
    task.contactId
      ? supabase.from("contacts").select("id").eq("organization_id", orgId).eq("id", task.contactId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    task.companyId
      ? supabase.from("companies").select("id").eq("organization_id", orgId).eq("id", task.companyId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  const { error } = await supabase.from("tasks").insert({
    organization_id: orgId,
    title: task.title,
    task_type: "todo",
    priority: 2,
    // a day without a time is due at the start of the working day, like the task form
    due_at: task.dueDate ? zonedIso(task.dueDate, "09:00:00", timeZone) : null,
    deal_id: task.dealId,
    contact_id: !contact.error && contact.data ? contact.data.id : null,
    company_id: !company.error && company.data ? company.data.id : null,
    ...(task.ownerId ? { owner_id: task.ownerId } : {}),
  });
  return error;
}

export type WonDeal = { id: string; name: string; ownerId: string | null; contactId: string | null; companyId: string | null };
export type OnboardingCounts = { created: number; existing: number; failed: number };

// deals handled at the same time
const PARALLEL = 8;

/**
 * DEAL-04, the bulk close window: one onboarding task per deal that was just
 * won, with the single window's defaults: its title, the deal's owner (when an
 * active member who writes; else the user), due the next working day. A deal
 * that already has an open onboarding task gets none. Counts what happened.
 */
export async function addBulkOnboardingTasks(supabase: Supabase, orgId: string, deals: WonDeal[], today: string, timeZone: string): Promise<OnboardingCounts> {
  const counts = { created: 0, existing: 0, failed: 0 };
  if (deals.length === 0) return counts;
  const owners = [...new Set(deals.map((deal) => deal.ownerId).filter((id): id is string => Boolean(id)))];
  const [settings, members] = await Promise.all([
    readCalendarSettings(supabase, orgId),
    owners.length > 0
      ? supabase.from("memberships").select("user_id").eq("organization_id", orgId).eq("status", "active").neq("role", "viewer").in("user_id", owners)
      : Promise.resolve({ data: [] as { user_id: string }[], error: null }),
  ]);
  if ("error" in settings || members.error) {
    counts.failed = deals.length;
    return counts;
  }
  const writers = new Set((members.data ?? []).map((member) => member.user_id));
  const dueDate = onboardingDueDate(today, settings.calendar);

  const one = async (deal: WonDeal) => {
    const existing = await openOnboardingTask(supabase, orgId, deal.id);
    if ("error" in existing) return "failed" as const;
    if (existing.open) return "existing" as const;
    const error = await insertOnboardingTask(
      supabase,
      orgId,
      {
        dealId: deal.id,
        contactId: deal.contactId,
        companyId: deal.companyId,
        title: onboardingTitle(deal.name),
        dueDate,
        ownerId: deal.ownerId && writers.has(deal.ownerId) ? deal.ownerId : null,
      },
      timeZone,
    );
    return error ? ("failed" as const) : ("created" as const);
  };
  for (let i = 0; i < deals.length; i += PARALLEL) {
    for (const result of await Promise.all(deals.slice(i, i + PARALLEL).map(one))) counts[result]++;
  }
  return counts;
}

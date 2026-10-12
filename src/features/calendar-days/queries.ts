import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { calendarSettingsFromRow, type CalendarSettings } from "./holidays";

/** The organization's rest days; the defaults while nobody has saved them. */
export async function getCalendarSettings(orgId: string): Promise<CalendarSettings> {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("org_calendar_settings")
      .select("rest_weekdays, holidays_rest, holiday_eves_rest, rest_occasions")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "calendar settings",
  );
  return calendarSettingsFromRow(row);
}

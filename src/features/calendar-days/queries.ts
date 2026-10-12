import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { DEFAULT_CALENDAR_SETTINGS, restDays, type CalendarSettings } from "./holidays";

/** The organization's rest days; the defaults while nobody has saved them. */
export async function getCalendarSettings(orgId: string): Promise<CalendarSettings> {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("org_calendar_settings")
      .select("rest_weekdays, holidays_rest, holiday_eves_rest")
      .eq("organization_id", orgId)
      .maybeSingle(),
    "calendar settings",
  );
  if (!row) return DEFAULT_CALENDAR_SETTINGS;
  return {
    restWeekdays: restDays({ restWeekdays: row.rest_weekdays as CalendarSettings["restWeekdays"] }),
    holidaysRest: row.holidays_rest,
    holidayEvesRest: row.holiday_eves_rest,
  };
}

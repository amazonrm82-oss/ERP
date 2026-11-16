import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type ReportScheduleView = {
  id: string;
  reportKey: string;
  period: string | null;
  frequency: "daily" | "weekly";
  weekday: number | null;
  sendAt: string;
  enabled: boolean;
  recipients: string[];
};

/**
 * RPT-03: the schedules the person may see, with the user's session: every schedule for owners and admins, the ones the
 * person receives for everyone else (report_schedules_select). Recipients as RLS shows them: all for owners and admins,
 * the person's own row for a member.
 */
export async function listReportSchedules(orgId: string): Promise<ReportScheduleView[]> {
  const supabase = await createClient();
  const [schedules, recipients] = await Promise.all([
    supabase
      .from("report_schedules")
      .select("id, report_key, period, frequency, weekday, send_at, enabled")
      .eq("organization_id", orgId)
      .order("created_at")
      .order("id"),
    supabase.from("report_schedule_recipients").select("schedule_id, user_id").eq("organization_id", orgId),
  ]);
  const rows = must(schedules, "report_schedules");
  const people = must(recipients, "report_schedule_recipients");
  return rows.map((row) => ({
    id: row.id,
    reportKey: row.report_key,
    period: row.period,
    frequency: row.frequency === "daily" ? "daily" : "weekly",
    weekday: row.weekday,
    sendAt: row.send_at.slice(0, 5),
    enabled: row.enabled,
    recipients: people.filter((p) => p.schedule_id === row.id).map((p) => p.user_id),
  }));
}

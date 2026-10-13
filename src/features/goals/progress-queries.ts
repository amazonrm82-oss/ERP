import "server-only";

import { parseReportData } from "@/features/reports/schemas";
import { getUserNames } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { readAllPages } from "@/lib/paged-read";
import { zoneDate, zonedIso } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import { addMonths, type GoalPeriod } from "./metrics";
import { periodEnd, teamSubtree, type GoalProgress } from "./progress";

// today: the organization's calendar date, for the pace rules of progressFigures()
export type NamedGoalProgress = GoalProgress & { subject: string; today: string };

type Options = {
  // an exact period; without it, the goals whose period holds today
  period?: { period: GoalPeriod; periodStart: string } | null;
  // only this person's own goals
  userId?: string | null;
};

/**
 * Progress against the goals the caller may read (GOL-03), with the user's session:
 * goals_select decides which goals, RLS which records are counted.
 */
export async function getGoalProgress(orgId: string, options: Options = {}): Promise<NamedGoalProgress[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_goal_progress", {
    p_org: orgId,
    p_period: options.period?.period ?? null,
    p_period_start: options.period?.periodStart ?? null,
    p_user: options.userId ?? null,
  });
  if (error) {
    throw new Error(`report_goal_progress failed: ${error.message}`);
  }
  // a mismatch throws ReportShapeError; withReportShape() logs it and shows the message
  const rows = parseReportData("report_goal_progress", data);
  if (rows.length === 0) {
    return [];
  }

  const teamIds = rows.filter((r) => r.scope === "team").map((r) => r.team_id);
  const [names, teams, org] = await Promise.all([
    getUserNames(rows.map((r) => r.user_id)),
    teamIds.length > 0 ? supabase.from("teams").select("id, name").eq("organization_id", orgId) : Promise.resolve(null),
    supabase.from("organizations").select("timezone").eq("id", orgId),
  ]);
  const timeZone = (must(org, "organizations") ?? [])[0]?.timezone;
  const today = timeZone ? zoneDate(new Date(), timeZone) : zoneDate(new Date());
  const teamName = new Map((teams ? (must(teams, "teams") ?? []) : []).map((t) => [t.id, t.name]));

  return rows.map((r) => ({
    goalId: r.goal_id,
    scope: r.scope,
    subjectId: r.scope === "user" ? r.user_id : r.scope === "team" ? r.team_id : null,
    subject:
      r.scope === "org" ? "כל העסק" : r.scope === "team" ? (teamName.get(r.team_id ?? "") ?? "צוות") : (names.get(r.user_id ?? "") ?? "משתמש"),
    period: r.period,
    periodStart: r.period_start.slice(0, 10),
    metric: r.metric,
    target: r.target,
    actual: r.actual,
    elapsed: r.elapsed,
    today,
  }));
}

/**
 * The person's own closed revenue this month (report_revenue's definition: won deals they own,
 * closed this month in the organization's zone), for "My day" when no goal is shown (owner,
 * 13 October 2026).
 */
export async function getMyMonthClosings(orgId: string, userId: string, timeZone: string): Promise<number> {
  const month = zoneDate(new Date(), timeZone).slice(0, 7);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("report_revenue", {
    p_org: orgId,
    p_from: zonedIso(`${month}-01`, "00:00:00", timeZone),
    p_to: zonedIso(`${addMonths(month, 1)}-01`, "00:00:00", timeZone),
    p_owner: userId,
  });
  if (error) {
    throw new Error(`report_revenue failed: ${error.message}`);
  }
  return parseReportData("report_revenue", data).by_owner.reduce((sum, row) => sum + row.amount, 0);
}

export type GoalDeal = { id: string; name: string; ownerId: string | null; amount: number; closedAt: string };

/**
 * The won deals a team goal counts (option A: by the team set on the deal, the team and the teams
 * below it), or with team "none" the won deals with no team; in one goal period, org time zone.
 * Read with the user's session: a manager of the team reads exactly these.
 */
export async function listGoalDeals(
  orgId: string,
  team: string | "none",
  period: GoalPeriod,
  periodStart: string,
  timeZone: string,
): Promise<GoalDeal[]> {
  const supabase = await createClient();
  const from = zonedIso(periodStart, "00:00:00", timeZone);
  const to = zonedIso(periodEnd(period, periodStart), "00:00:00", timeZone);
  let teams: string[] = [];
  if (team !== "none") {
    const all = must(await supabase.from("teams").select("id, parent_team_id").eq("organization_id", orgId), "teams") ?? [];
    teams = teamSubtree(team, all);
  }
  const { rows } = await readAllPages(async (start, end) => {
    let query = supabase
      .from("deals")
      .select("id, name, owner_id, amount_agorot, closed_at")
      .eq("organization_id", orgId)
      .eq("status", "won")
      .is("deleted_at", null)
      .gte("closed_at", from)
      .lt("closed_at", to);
    query = team === "none" ? query.is("team_id", null) : query.in("team_id", teams);
    return must(await query.order("closed_at", { ascending: false }).order("id").range(start, end), "deals") ?? [];
  });
  // won deals always carry closed_at (deals_sync_stage_close)
  return rows.map((d) => ({ id: d.id, name: d.name, ownerId: d.owner_id, amount: d.amount_agorot, closedAt: String(d.closed_at) }));
}

/** Won deals of one goal period with no team (owners and admins see them next to the team goals). */
export async function getUnteamedWon(orgId: string, period: GoalPeriod, periodStart: string, timeZone: string): Promise<{ deals: number; amount: number }> {
  const deals = await listGoalDeals(orgId, "none", period, periodStart, timeZone);
  return { deals: deals.length, amount: deals.reduce((sum, d) => sum + d.amount, 0) };
}

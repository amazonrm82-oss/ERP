import "server-only";

import { listMembers, listTeams } from "@/features/settings/queries";
import type { OrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { readAllPages } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { goalColumns, managedTeams, rowKey, type GoalColumn, type GoalGridRow, type GoalValue, type GoalView } from "./grid";
import type { GoalScope } from "./metrics";

type GoalReadRow = { scope: string; user_id: string | null; team_id: string | null; period_start: string; target: number };

/** Goals of one metric and period between two period starts (inclusive), as the caller may read them (RLS). */
export async function readGoals(orgId: string, view: Omit<GoalView, "year">, from: string, to: string): Promise<GoalValue[]> {
  const supabase = await createClient();
  const { rows } = await readAllPages<GoalReadRow>(async (start, end) =>
    must(
      await supabase
        .from("goals")
        .select("scope, user_id, team_id, period_start, target")
        .eq("organization_id", orgId)
        .eq("metric", view.metric)
        .eq("period", view.period)
        .gte("period_start", from)
        .lte("period_start", to)
        .order("id")
        .range(start, end),
      "goals",
    ),
  );
  return rows.map((r) => ({
    scope: r.scope as GoalScope,
    subjectId: r.scope === "user" ? r.user_id : r.scope === "team" ? r.team_id : null,
    periodStart: r.period_start.slice(0, 10),
    target: Number(r.target),
  }));
}

export type GoalsGrid = {
  columns: GoalColumn[];
  rows: GoalGridRow[];
  values: GoalValue[];
  // the rows the caller may change (keys): every row for owners and admins, the teams a
  // manager manages and their people (not themselves); none while the business is read only.
  // The database decides either way (goals policies, app.goals_manager_may_write).
  editable: string[];
};

async function managerScope(orgId: string, userId: string): Promise<{ teams: Set<string>; people: Set<string> }> {
  const supabase = await createClient();
  const [teams, members] = await Promise.all([
    supabase.from("teams").select("id, parent_team_id").eq("organization_id", orgId),
    supabase.from("team_members").select("team_id, user_id, is_manager").eq("organization_id", orgId),
  ]);
  const teamRows = must(teams, "teams");
  const memberRows = must(members, "team_members");
  const managed = managedTeams(userId, teamRows, memberRows);
  const people = new Set(memberRows.filter((m) => managed.has(m.team_id) && m.user_id !== userId).map((m) => m.user_id));
  return { teams: managed, people };
}

/**
 * The grid of one metric, period and year. Owners and admins get every active person (not
 * viewers), every team and the business; others get the business, themselves, the rows whose
 * goals they may read, and (managers) the teams they manage and the people in them.
 */
export async function getGoalsGrid(context: OrgContext, view: GoalView): Promise<GoalsGrid> {
  const orgId = context.org.id;
  const columns = goalColumns(view.period, view.year);
  const isAdmin = context.role === "owner" || context.role === "admin";
  const [members, teams, values, scope] = await Promise.all([
    listMembers(orgId),
    listTeams(orgId),
    readGoals(orgId, view, columns[0].start, columns[columns.length - 1].start),
    context.role === "manager" ? managerScope(orgId, context.user.id) : Promise.resolve(null),
  ]);

  const people = members
    .filter((m) => m.status === "active" && m.role !== "viewer")
    .map((m): GoalGridRow => ({
      key: "",
      scope: "user",
      subjectId: m.userId,
      label: m.userId === context.user.id ? `${m.name} (אני)` : m.name,
    }));
  const all: GoalGridRow[] = ([
    { key: "", scope: "org", subjectId: null, label: "כל העסק" } satisfies GoalGridRow,
    ...teams.map((t): GoalGridRow => ({ key: "", scope: "team", subjectId: t.id, label: t.name, hint: "צוות" })),
    ...people,
  ] as GoalGridRow[]).map((row) => ({ ...row, key: rowKey(row) }));

  // strict until the owner answers: a manager sets goals only for people whose role is member
  // (never an owner, an admin or another manager), the rule of app.goals_manager_may_write
  const roleOf = new Map(members.map((m) => [m.userId, m.role]));
  const mayWrite = (row: GoalGridRow) =>
    isAdmin ||
    (scope !== null &&
      ((row.scope === "team" && scope.teams.has(row.subjectId ?? "")) || (row.scope === "user" && scope.people.has(row.subjectId ?? "") && roleOf.get(row.subjectId ?? "") === "member")));
  const withGoals = new Set(values.map(rowKey));
  const rows = isAdmin
    ? all
    : all.filter(
        (row) => row.scope === "org" || (row.scope === "user" && row.subjectId === context.user.id) || withGoals.has(row.key) || mayWrite(row),
      );

  return { columns, rows, values, editable: context.canWrite ? rows.filter(mayWrite).map((r) => r.key) : [] };
}

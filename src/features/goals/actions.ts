"use server";

import { revalidatePath } from "next/cache";

import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";

import { copyPlan, previousStart, type GoalValue } from "./grid";
import { goalMetric, parseTarget } from "./metrics";
import { readGoals } from "./queries";
import { goalCellArg, goalCopyArg, goalRowsArg, type GoalCellArg, type GoalCopyArg, type GoalRowsArg } from "./schema";

// GOL-02: owners and admins set any goal in the grid, managers only their teams' and those teams' members'
// (owner, 13 October 2026); RLS decides and refuses everyone else (42501 / 0 rows).
// Saving a cell does not revalidate the page: the grid keeps its own state, and a refresh
// would re-mount it and take the focus away from the next cell. The copy does revalidate.

const SAVE_FAILED = "לא הצלחנו לשמור את היעד. נסו שוב.";

type Context = Extract<Awaited<ReturnType<typeof actionContext>>, { ok: true }>;

function subjectColumns(cell: Pick<GoalCellArg, "scope" | "subjectId">) {
  return { user_id: cell.scope === "user" ? cell.subjectId : null, team_id: cell.scope === "team" ? cell.subjectId : null };
}

async function findGoal(context: Context, orgId: string, cell: GoalCellArg) {
  const { user_id, team_id } = subjectColumns(cell);
  let query = context.supabase
    .from("goals")
    .select("id")
    .eq("organization_id", orgId)
    .eq("scope", cell.scope)
    .eq("period", cell.period)
    .eq("period_start", cell.periodStart)
    .eq("metric", cell.metric);
  query = user_id ? query.eq("user_id", user_id) : query.is("user_id", null);
  query = team_id ? query.eq("team_id", team_id) : query.is("team_id", null);
  return query.maybeSingle();
}

/** Saves one cell: a new goal, a changed target, or (empty text) no goal. Answers the stored target. */
export async function saveGoalAction(orgId: string, cell: GoalCellArg): Promise<ActionResult<{ target: number | null }>> {
  if (!validArg(goalCellArg, cell)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  const parsed = parseTarget(goalMetric(cell.metric).kind, cell.value);
  if (!parsed.ok) {
    return fail(parsed.message);
  }

  const existing = await findGoal(context, orgId, cell);
  if (existing.error) {
    return fail(dbErrorMessage(existing.error, SAVE_FAILED));
  }

  if (parsed.value === null) {
    if (existing.data) {
      const { data, error } = await context.supabase.from("goals").delete().eq("organization_id", orgId).eq("id", existing.data.id).select("id");
      if (error) return fail(dbErrorMessage(error, SAVE_FAILED));
      if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
    }
    return ok({ target: null });
  }

  if (existing.data) {
    const { data, error } = await context.supabase
      .from("goals")
      .update({ target: parsed.value })
      .eq("organization_id", orgId)
      .eq("id", existing.data.id)
      .select("id");
    if (error) return fail(dbErrorMessage(error, SAVE_FAILED));
    if (data.length === 0) return fail(NOT_FOUND_OR_FORBIDDEN);
  } else {
    const { error } = await context.supabase.from("goals").insert({
      organization_id: orgId,
      scope: cell.scope,
      ...subjectColumns(cell),
      period: cell.period,
      period_start: cell.periodStart,
      metric: cell.metric,
      target: parsed.value,
    });
    if (error) {
      // someone else set this goal a moment ago: refresh the grid rather than overwrite it
      return fail(error.code === "23505" ? "היעד הזה נשמר עכשיו ממקום אחר. רעננו את הדף." : dbErrorMessage(error, SAVE_FAILED));
    }
  }
  return ok({ target: parsed.value });
}

/**
 * Copies the previous period's goals into one column, only into cells that are still empty,
 * and only for the people, teams and business the grid shows (`rows`). Answers how many were added.
 */
export async function copyGoalsAction(
  orgId: string,
  copy: GoalCopyArg,
  rows: GoalRowsArg,
): Promise<ActionResult<{ added: number; previous: number }>> {
  if (!validArg(goalCopyArg, copy) || !validArg(goalRowsArg, rows)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, ...rows.flatMap((r) => (r.subjectId ? [r.subjectId] : [])));
  if (!context.ok) {
    return context;
  }
  const from = previousStart(copy.period, copy.periodStart);
  let values: GoalValue[];
  try {
    // the previous period and the target one are next to each other: one range holds both
    values = await readGoals(orgId, { metric: copy.metric, period: copy.period }, from, copy.periodStart);
  } catch (error) {
    return fail(dbErrorMessage(error));
  }
  const previous = values.filter((v) => v.periodStart === from);
  const plan = copyPlan(previous, values, rows, copy.periodStart);
  if (plan.length > 0) {
    const { error: insertError } = await context.supabase.from("goals").insert(
      plan.map((v) => ({
        organization_id: orgId,
        scope: v.scope,
        ...subjectColumns(v),
        period: copy.period,
        period_start: v.periodStart,
        metric: copy.metric,
        target: v.target,
      })),
    );
    if (insertError) {
      return fail(insertError.code === "23505" ? "חלק מהיעדים נשמרו עכשיו ממקום אחר. רעננו את הדף ונסו שוב." : dbErrorMessage(insertError));
    }
  }
  revalidatePath(paths.goals(orgId));
  return ok({ added: plan.length, previous: previous.length });
}

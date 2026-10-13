import "server-only";

import { getCalendarSettings } from "@/features/calendar-days/queries";
import { activeLossReasons, listLossReasons, type LossReasonOption } from "@/features/deal-loss-reasons/queries";
import { closeWindowSetup, type CloseWindowSetup } from "@/features/deals/close-window";
import { listMembers } from "@/features/settings/queries";
import { canEditRecordHint, type OrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { zoneDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import type { OverdueDeal } from "./definitions";

type StageRef = { id: string; name: string };

export type OverdueActionsSetup = {
  // deals the user may change (a hint: the database decides; 0 rows = not permitted)
  editable: string[];
  // per pipeline, the stage a win and a loss go to (the first of each kind)
  stages: Record<string, { won: StageRef | null; lost: StageRef | null }>;
  lossReasons: LossReasonOption[];
  closeWindow: CloseWindowSetup;
  today: string;
};

/** What the forecast screen's overdue list needs for its actions (GOL-04); null when nothing can be done. */
export async function getOverdueActionsSetup(context: OrgContext, deals: OverdueDeal[]): Promise<OverdueActionsSetup | null> {
  const editable = deals.filter((deal) => canEditRecordHint(context, deal.ownerId)).map((deal) => deal.id);
  if (!context.canWrite || editable.length === 0) {
    return null;
  }
  const orgId = context.org.id;
  const pipelineIds = [...new Set(deals.map((deal) => deal.pipelineId))];
  const supabase = await createClient();
  const [stageRows, reasons, members, calendar] = await Promise.all([
    supabase
      .from("stages")
      .select("id, name, kind, pipeline_id, position")
      .eq("organization_id", orgId)
      .in("pipeline_id", pipelineIds)
      .in("kind", ["won", "lost"])
      .order("position"),
    listLossReasons(orgId),
    listMembers(orgId),
    getCalendarSettings(orgId),
  ]);
  const stages: OverdueActionsSetup["stages"] = {};
  for (const stage of must(stageRows, "stages") ?? []) {
    const entry = (stages[stage.pipeline_id] ??= { won: null, lost: null });
    if (stage.kind === "won" && !entry.won) entry.won = { id: stage.id, name: stage.name };
    if (stage.kind === "lost" && !entry.lost) entry.lost = { id: stage.id, name: stage.name };
  }
  return {
    editable,
    stages,
    lossReasons: activeLossReasons(reasons),
    // DEAL-04: the onboarding task goes to an active member who writes
    closeWindow: closeWindowSetup(
      members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ value: m.userId, label: m.name })),
      context.org.timeZone,
      calendar,
      context.user.id,
    ),
    today: zoneDate(new Date(), context.org.timeZone),
  };
}

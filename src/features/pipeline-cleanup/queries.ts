import "server-only";

import { getCalendarSettings } from "@/features/calendar-days/queries";
import { activeLossReasons, listLossReasons, type LossReasonOption } from "@/features/deal-loss-reasons/queries";
import { closeWindowSetup, type CloseWindowSetup } from "@/features/deals/close-window";
import { parseReportData, type ReportData } from "@/features/reports/schemas";
import { listMembers } from "@/features/settings/queries";
import { canEditRecordHint, getUserNames, type OrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import type { CleanupDeal, CleanupStage } from "./rules";

type StageRef = { id: string; name: string };

export type CleanupList = {
  today: string;
  deals: CleanupDeal[];
  // every deal the caller sees, each once (the list holds at most 300)
  total: number;
  amount: number;
};

export type CleanupActions = {
  // deals the user may change (a hint: the database decides; 0 rows = not permitted)
  editable: string[];
  // per pipeline: its open stages in order, and the stage a win and a loss go to (the first of each kind)
  stages: Record<string, { open: CleanupStage[]; won: StageRef | null; lost: StageRef | null }>;
  lossReasons: LossReasonOption[];
  closeWindow: CloseWindowSetup;
  today: string;
};

/** The raw cleanup report (security invoker: the user sees only deals they may see), checked (FXC-12). */
export async function readPipelineCleanup(orgId: string, ownerId: string | null): Promise<ReportData<"report_pipeline_cleanup"> | null> {
  const supabase = await createClient();
  const raw = must(await supabase.rpc("report_pipeline_cleanup", { p_org: orgId, p_owner: ownerId }), "pipeline cleanup");
  // null: the organization is not visible to the caller
  return raw === null ? null : parseReportData("report_pipeline_cleanup", raw);
}

/** MNY-05: the open deals that need a decision, stuck or past their close date, each once. */
export async function getPipelineCleanup(orgId: string, ownerId: string | null): Promise<CleanupList | null> {
  const data = await readPipelineCleanup(orgId, ownerId);
  if (!data) return null;
  const names = await getUserNames(data.deals.map((row) => row.owner_id));
  return {
    today: data.today,
    total: data.stuck.deals + data.overdue.deals,
    amount: data.stuck.amount + data.overdue.amount,
    deals: data.deals.map((row) => ({
      id: row.id,
      name: row.name ?? "",
      ownerId: row.owner_id,
      ownerName: row.owner_id ? (names.get(row.owner_id) ?? null) : null,
      pipelineId: row.pipeline_id,
      stageId: row.stage_id,
      stageName: row.stage_name,
      stagePosition: row.stage_position,
      amount: row.amount_agorot,
      contactId: row.contact_id,
      expected: row.expected_close_date ? row.expected_close_date.slice(0, 10) : null,
      daysInStage: row.days_in_stage,
      limitDays: row.limit_days,
      lastActivityAt: row.last_activity_at,
      idleDays: row.idle_days,
      stuck: row.stuck,
      overdue: row.overdue,
    })),
  };
}

/** What the three choices need (advance, postpone, close as lost; and a win from "advance"); null when nothing can be done. */
export async function getCleanupActions(context: OrgContext, deals: CleanupDeal[], today: string): Promise<CleanupActions | null> {
  const editable = deals.filter((deal) => canEditRecordHint(context, deal.ownerId)).map((deal) => deal.id);
  if (!context.canWrite || editable.length === 0) {
    return null;
  }
  const orgId = context.org.id;
  const pipelineIds = [...new Set(deals.map((deal) => deal.pipelineId))];
  const supabase = await createClient();
  const [stageRows, reasons, members, calendar] = await Promise.all([
    supabase.from("stages").select("id, name, kind, pipeline_id, position").eq("organization_id", orgId).in("pipeline_id", pipelineIds).order("position"),
    listLossReasons(orgId),
    listMembers(orgId),
    getCalendarSettings(orgId),
  ]);
  const stages: CleanupActions["stages"] = {};
  for (const stage of must(stageRows, "stages") ?? []) {
    const entry = (stages[stage.pipeline_id] ??= { open: [], won: null, lost: null });
    if (stage.kind === "open") entry.open.push({ id: stage.id, name: stage.name, position: stage.position });
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
    today,
  };
}

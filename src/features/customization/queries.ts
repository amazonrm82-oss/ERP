import "server-only";

import type { LeadStatusKind, StageKind } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type StageSetting = {
  id: string;
  name: string;
  kind: StageKind;
  probability: number;
  position: number;
  dealCount: number;
  // DEAL-01: a palette key or null (by kind); days allowed in the stage or null (the default)
  color: string | null;
  rotDays: number | null;
};
export type PipelineSetting = { id: string; name: string; isDefault: boolean; stages: StageSetting[]; liveDealCount: number };

/** Live pipelines with their stages and how many deals (trashed included) sit in each stage. */
export async function listPipelineSettings(orgId: string): Promise<PipelineSetting[]> {
  const supabase = await createClient();
  const [pipelines, stages] = await Promise.all([
    supabase
      .from("pipelines")
      .select("id, name, is_default, position, created_at")
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .order("is_default", { ascending: false })
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("stages")
      .select("id, pipeline_id, name, kind, probability, position, color, rot_days")
      .eq("organization_id", orgId)
      .order("position", { ascending: true }),
  ]);
  if (pipelines.error || stages.error) {
    throw new Error(`pipeline settings query failed: ${(pipelines.error ?? stages.error)?.message}`);
  }

  // Counted in the database (one small query each): a stage that holds deals,
  // even trashed ones, cannot be deleted. Admins see every deal, so the counts
  // are complete for the people who can edit here.
  const [stageCounts, pipelineCounts] = await Promise.all([
    Promise.all(
      stages.data.map((stage) =>
        supabase.from("deals").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("stage_id", stage.id),
      ),
    ),
    Promise.all(
      pipelines.data.map((pipeline) =>
        supabase
          .from("deals")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", orgId)
          .eq("pipeline_id", pipeline.id)
          .is("deleted_at", null),
      ),
    ),
  ]);
  const perStage = new Map(stages.data.map((stage, i) => [stage.id, stageCounts[i].count ?? 0]));
  const livePerPipeline = new Map(pipelines.data.map((pipeline, i) => [pipeline.id, pipelineCounts[i].count ?? 0]));

  return pipelines.data.map((pipeline) => ({
    id: pipeline.id,
    name: pipeline.name,
    isDefault: pipeline.is_default,
    liveDealCount: livePerPipeline.get(pipeline.id) ?? 0,
    stages: stages.data
      .filter((stage) => stage.pipeline_id === pipeline.id)
      .map((stage) => ({
        id: stage.id,
        name: stage.name,
        kind: stage.kind,
        probability: stage.probability,
        position: stage.position,
        color: stage.color,
        rotDays: stage.rot_days,
        dealCount: perStage.get(stage.id) ?? 0,
      })),
  }));
}

export type StatusSetting = { id: string; name: string; kind: LeadStatusKind; isDefault: boolean; position: number; leadCount: number };
export type SourceSetting = { id: string; name: string; isActive: boolean };

export async function listLeadSettings(orgId: string): Promise<{ statuses: StatusSetting[]; sources: SourceSetting[] }> {
  const supabase = await createClient();
  const [statuses, sources] = await Promise.all([
    supabase
      .from("lead_statuses")
      .select("id, name, kind, is_default, position")
      .eq("organization_id", orgId)
      .order("position", { ascending: true }),
    supabase.from("lead_sources").select("id, name, is_active").eq("organization_id", orgId).order("name", { ascending: true }),
  ]);
  if (statuses.error || sources.error) {
    throw new Error(`lead settings query failed: ${(statuses.error ?? sources.error)?.message}`);
  }
  const counts = await Promise.all(
    statuses.data.map((status) =>
      supabase.from("leads").select("id", { count: "exact", head: true }).eq("organization_id", orgId).eq("status_id", status.id),
    ),
  );
  const perStatus = new Map(statuses.data.map((status, i) => [status.id, counts[i].count ?? 0]));
  return {
    statuses: statuses.data.map((status) => ({
      id: status.id,
      name: status.name,
      kind: status.kind,
      isDefault: status.is_default,
      position: status.position,
      leadCount: perStatus.get(status.id) ?? 0,
    })),
    sources: sources.data.map((source) => ({ id: source.id, name: source.name, isActive: source.is_active })),
  };
}

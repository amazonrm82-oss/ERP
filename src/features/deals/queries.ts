import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { StageKind } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/server";

export type StageOption = { id: string; name: string; kind: StageKind };

export type BoardDeal = {
  id: string;
  name: string;
  amountAgorot: number;
  stageId: string;
  contactId: string | null;
  contactName: string | null;
};

export type StageTotal = { count: number; amountAgorot: number };

export type Board = {
  pipeline: { id: string; name: string };
  stages: StageOption[];
  deals: BoardDeal[];
  // exact count and sum per stage (the board loads only part of the deals)
  totals: Record<string, StageTotal>;
  // stages whose deals were loaded (closed stages only on request)
  loadedStages: string[];
  showClosed: boolean;
};

// Cards loaded per stage: the most recently moved first. One stage can be opened in full.
export const STAGE_LIMIT = 50;
export const STAGE_FULL_LIMIT = 500;

export type PipelineOption = { id: string; name: string; isDefault: boolean };

/** Live pipelines, default first. */
export async function listPipelines(orgId: string): Promise<PipelineOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pipelines")
    .select("id, name, is_default")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) {
    throw new Error(`pipelines query failed: ${error.message}`);
  }
  return data.map((row) => ({ id: row.id, name: row.name, isDefault: row.is_default }));
}

/**
 * A live pipeline with its stages in order: the requested one when it exists,
 * else the default (or first) one. Null when the organization has none.
 */
export async function getPipeline(
  orgId: string,
  pipelineId?: string | null,
): Promise<{ id: string; name: string; stages: StageOption[] } | null> {
  const pipelines = await listPipelines(orgId);
  const pipeline = pipelines.find((p) => p.id === pipelineId) ?? pipelines[0];
  if (!pipeline) {
    return null;
  }
  const supabase = await createClient();
  const { data: stages, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipeline.id)
    .order("position", { ascending: true });
  if (stagesError) {
    throw new Error(`stages query failed: ${stagesError.message}`);
  }
  return { id: pipeline.id, name: pipeline.name, stages };
}

/** Kanban data for a pipeline (default: the default one), or null when the organization has no pipeline. */
export async function getBoard(
  orgId: string,
  pipelineId?: string | null,
  options: { showClosed?: boolean; fullStage?: string | null } = {},
): Promise<Board | null> {
  const pipeline = await getPipeline(orgId, pipelineId);
  if (!pipeline) {
    return null;
  }
  const supabase = await createClient();
  const showClosed = options.showClosed === true;
  const loadedStages = pipeline.stages.filter((stage) => showClosed || stage.kind === "open").map((stage) => stage.id);

  const [totalsResult, ...stageResults] = await Promise.all([
    supabase.rpc("deal_stage_totals", { p_org: orgId, p_pipeline: pipeline.id }),
    ...loadedStages.map((stageId) =>
      supabase
        .from("deals")
        .select("id, name, amount_agorot, stage_id, contact_id")
        .eq("organization_id", orgId)
        .eq("pipeline_id", pipeline.id)
        .eq("stage_id", stageId)
        .is("deleted_at", null)
        .order("stage_entered_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(options.fullStage === stageId ? STAGE_FULL_LIMIT : STAGE_LIMIT),
    ),
  ]);
  for (const result of stageResults) {
    if (result.error) {
      throw new Error(`deals query failed: ${result.error.message}`);
    }
  }
  const rows = stageResults.flatMap((result) => result.data ?? []);

  const totals: Record<string, StageTotal> = {};
  for (const t of (Array.isArray(totalsResult.data) ? totalsResult.data : []) as Array<{ stage_id: string; count: number; amount_agorot: number }>) {
    totals[t.stage_id] = { count: Number(t.count), amountAgorot: Number(t.amount_agorot) };
  }

  const contactIds = [...new Set(rows.map((row) => row.contact_id).filter((id): id is string => Boolean(id)))];
  const contactNames = new Map<string, string>();
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, full_name, email, phone")
      .eq("organization_id", orgId)
      .in("id", contactIds);
    for (const contact of contacts ?? []) {
      contactNames.set(contact.id, contact.full_name || contact.email || contact.phone || "איש קשר ללא שם");
    }
  }

  return {
    pipeline: { id: pipeline.id, name: pipeline.name },
    stages: pipeline.stages,
    totals,
    loadedStages,
    showClosed,
    deals: rows.map((row) => ({
      id: row.id,
      name: row.name,
      amountAgorot: row.amount_agorot,
      stageId: row.stage_id,
      contactId: row.contact_id,
      contactName: row.contact_id ? (contactNames.get(row.contact_id) ?? null) : null,
    })),
  };
}

export type RelatedDeal = { id: string; name: string; amountAgorot: number; stageName: string | null; status: StageKind };

/** Live deals whose main contact (or company) is the given record, newest first (latest 50). */
export async function listRelatedDeals(
  orgId: string,
  related: { contactId: string } | { companyId: string },
): Promise<RelatedDeal[]> {
  const supabase = await createClient();
  const [column, value] = "contactId" in related ? ["contact_id", related.contactId] : ["company_id", related.companyId];
  const { data, error } = await supabase
    .from("deals")
    .select("id, name, amount_agorot, stage_id, status")
    .eq("organization_id", orgId)
    .eq(column, value)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`related deals query failed: ${error.message}`);
  }
  if (data.length === 0) {
    return [];
  }
  const { data: stages } = await supabase
    .from("stages")
    .select("id, name")
    .eq("organization_id", orgId)
    .in("id", [...new Set(data.map((deal) => deal.stage_id))]);
  const stageNames = new Map((stages ?? []).map((stage) => [stage.id, stage.name]));

  return data.map((deal) => ({
    id: deal.id,
    name: deal.name,
    amountAgorot: deal.amount_agorot,
    stageName: stageNames.get(deal.stage_id) ?? null,
    status: deal.status,
  }));
}

/** A live deal with the names around it and the stages of its pipeline, or null. */
export async function getDeal(orgId: string, dealId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deals")
    .select(
      "id, name, amount_agorot, pipeline_id, stage_id, status, expected_close_date, closed_at, lost_reason, contact_id, company_id, owner_id, created_at, custom_fields, tag_ids",
    )
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) {
    throw new Error(`deal query failed: ${error.message}`);
  }
  if (!data) {
    return null;
  }

  const [stages, pipeline, contact, company, owners] = await Promise.all([
    supabase
      .from("stages")
      .select("id, name, kind")
      .eq("organization_id", orgId)
      .eq("pipeline_id", data.pipeline_id)
      .order("position", { ascending: true }),
    supabase.from("pipelines").select("name").eq("organization_id", orgId).eq("id", data.pipeline_id).maybeSingle(),
    data.contact_id
      ? supabase.from("contacts").select("full_name, email, phone").eq("organization_id", orgId).eq("id", data.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    data.company_id
      ? supabase.from("companies").select("name").eq("organization_id", orgId).eq("id", data.company_id).maybeSingle()
      : Promise.resolve({ data: null }),
    getUserNames([data.owner_id]),
  ]);

  return {
    ...data,
    stages: (stages.data ?? []) as StageOption[],
    pipelineName: pipeline.data?.name ?? null,
    contactName: contact.data ? contact.data.full_name || contact.data.email || contact.data.phone || "איש קשר ללא שם" : null,
    companyName: company.data?.name ?? null,
    ownerName: data.owner_id ? (owners.get(data.owner_id) ?? null) : null,
  };
}

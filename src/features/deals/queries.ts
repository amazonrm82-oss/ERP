import "server-only";

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

export type Board = {
  pipeline: { id: string; name: string };
  stages: StageOption[];
  deals: BoardDeal[];
  // true when the pipeline has more live deals than the board loads
  truncated: boolean;
};

// The board loads at most this many deals (most recently moved first).
export const BOARD_LIMIT = 500;

/** The organization's default pipeline (or its first one) with its stages in order. */
export async function getDefaultPipeline(orgId: string): Promise<{ id: string; name: string; stages: StageOption[] } | null> {
  const supabase = await createClient();
  const { data: pipelines, error } = await supabase
    .from("pipelines")
    .select("id, name")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("position", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) {
    throw new Error(`pipelines query failed: ${error.message}`);
  }
  const pipeline = pipelines[0];
  if (!pipeline) {
    return null;
  }

  const { data: stages, error: stagesError } = await supabase
    .from("stages")
    .select("id, name, kind")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipeline.id)
    .order("position", { ascending: true });
  if (stagesError) {
    throw new Error(`stages query failed: ${stagesError.message}`);
  }
  return { ...pipeline, stages };
}

/** Kanban data for the default pipeline, or null when the organization has no pipeline. */
export async function getBoard(orgId: string): Promise<Board | null> {
  const pipeline = await getDefaultPipeline(orgId);
  if (!pipeline) {
    return null;
  }
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("deals")
    .select("id, name, amount_agorot, stage_id, contact_id")
    .eq("organization_id", orgId)
    .eq("pipeline_id", pipeline.id)
    .is("deleted_at", null)
    .order("stage_entered_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(BOARD_LIMIT + 1);
  if (error) {
    throw new Error(`deals query failed: ${error.message}`);
  }
  const rows = data.slice(0, BOARD_LIMIT);

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
    truncated: data.length > BOARD_LIMIT,
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

export type ContactDeal = { id: string; name: string; amountAgorot: number; stageName: string | null; status: StageKind };

/** Live deals whose main contact is the given contact, newest first. */
export async function listDealsOfContact(orgId: string, contactId: string): Promise<ContactDeal[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("deals")
    .select("id, name, amount_agorot, stage_id, status")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`contact deals query failed: ${error.message}`);
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

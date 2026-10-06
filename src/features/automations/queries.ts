import "server-only";

import { listMembers, listTeams } from "@/features/settings/queries";
import { listTags } from "@/features/tags/queries";
import { createClient } from "@/lib/supabase/server";

export type Lookups = {
  statuses: Array<{ id: string; name: string; kind: string }>;
  sources: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string }> }>;
  members: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
};

/** Everything a rule may point at, from the user's own organization (RLS). */
export async function getLookups(orgId: string): Promise<Lookups> {
  const supabase = await createClient();
  const [statuses, sources, pipelines, stages, tags, members, teams] = await Promise.all([
    supabase.from("lead_statuses").select("id, name, kind").eq("organization_id", orgId).order("position"),
    supabase.from("lead_sources").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("pipelines").select("id, name").eq("organization_id", orgId).is("deleted_at", null).order("position"),
    supabase.from("stages").select("id, name, pipeline_id").eq("organization_id", orgId).order("position"),
    listTags(orgId),
    listMembers(orgId),
    listTeams(orgId),
  ]);
  return {
    statuses: statuses.data ?? [],
    sources: sources.data ?? [],
    tags,
    pipelines: (pipelines.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      stages: (stages.data ?? []).filter((s) => s.pipeline_id === p.id).map((s) => ({ id: s.id, name: s.name })),
    })),
    members: members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name })),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
  };
}

export type AutomationSummary = {
  id: string;
  name: string;
  isActive: boolean;
  templateKey: string | null;
  entity: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  conditions: Array<Record<string, unknown>>;
  actions: Array<Record<string, unknown>>;
  runs7d: number;
  failed7d: number;
};

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}

export async function listAutomations(orgId: string): Promise<AutomationSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automations")
    .select("id, name, is_active, template_key, entity_type, trigger_type, trigger_config, conditions, actions")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`automations query failed: ${error.message}`);
  }
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const counts = await Promise.all(
    data.map((row) =>
      Promise.all([
        supabase.from("automation_runs").select("id", { count: "exact", head: true }).eq("automation_id", row.id).gte("created_at", since),
        supabase
          .from("automation_runs")
          .select("id", { count: "exact", head: true })
          .eq("automation_id", row.id)
          .gte("created_at", since)
          .in("status", ["failed", "partial"]),
      ]),
    ),
  );
  return data.map((row, i) => ({
    id: row.id,
    name: row.name,
    isActive: row.is_active,
    templateKey: row.template_key,
    entity: row.entity_type,
    triggerType: row.trigger_type,
    triggerConfig: row.trigger_config && typeof row.trigger_config === "object" && !Array.isArray(row.trigger_config) ? row.trigger_config : {},
    conditions: objects(row.conditions),
    actions: objects(row.actions),
    runs7d: counts[i][0].count ?? 0,
    failed7d: counts[i][1].count ?? 0,
  }));
}

export async function getAutomation(orgId: string, id: string): Promise<AutomationSummary | null> {
  const all = await listAutomations(orgId);
  return all.find((a) => a.id === id) ?? null;
}

export type RunItem = {
  id: string;
  status: string;
  entityType: string;
  entityId: string;
  createdAt: string;
  steps: Array<{ action: string | null; status: string; error?: string }>;
};

export async function listRuns(orgId: string, automationId: string): Promise<RunItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automation_runs")
    .select("id, status, entity_type, entity_id, created_at, steps")
    .eq("organization_id", orgId)
    .eq("automation_id", automationId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`runs query failed: ${error.message}`);
  }
  return data.map((row) => ({
    id: row.id,
    status: row.status,
    entityType: row.entity_type,
    entityId: row.entity_id,
    createdAt: row.created_at,
    steps: objects(row.steps).map((s) => ({
      action: typeof s.action === "string" ? s.action : null,
      status: String(s.status ?? ""),
      error: typeof s.error === "string" ? s.error : undefined,
    })),
  }));
}

/** Recent records of a type, to pick one for a test run. */
export async function listTestRecords(orgId: string, entity: string): Promise<Array<{ id: string; name: string }>> {
  const supabase = await createClient();
  const table = ({ lead: "leads", contact: "contacts", company: "companies", deal: "deals", task: "tasks" } as const)[entity as "lead"];
  if (!table) {
    return [];
  }
  const column = entity === "task" ? "title" : entity === "company" || entity === "deal" ? "name" : "full_name";
  const { data } = await supabase
    .from(table as "leads")
    .select(`id, ${column}`)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(30);
  return ((data ?? []) as unknown as Array<Record<string, string | null>>).map((row) => ({ id: String(row.id), name: row[column] || "ללא שם" }));
}

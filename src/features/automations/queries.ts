import "server-only";
import { getOrgTerms } from "@/features/terminology/queries";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import type { FieldDefinition } from "@/features/custom-fields/types";
import { listMembers, listTeams, orgHasFeature } from "@/features/settings/queries";
import { listTags } from "@/features/tags/queries";
import { RECORD_TYPES } from "@/lib/record-types";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

export type Lookups = {
  statuses: Array<{ id: string; name: string; kind: string }>;
  sources: Array<{ id: string; name: string }>;
  tags: Array<{ id: string; name: string }>;
  // AUT-02: the stage kind, so a "create deal" step offers open stages only
  pipelines: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; kind: string }> }>;
  members: Array<{ id: string; name: string }>;
  teams: Array<{ id: string; name: string }>;
  // the active "not relevant" reasons (RVW-9), in the admin's order
  reasons: Array<{ id: string; name: string }>;
  // AUT-01: the active custom fields a "set_field" step may write, per record type (tasks have none)
  fields: Partial<Record<"lead" | "contact" | "company" | "deal", FieldDefinition[]>>;
  // FLD-10 part three: the business's word for a deal, for the default name of a deal a rule makes (absent = "עסקה")
  dealWord?: string;
  // PAY-07: whether the plan has payments (the "payment received" trigger is offered only then)
  payments?: boolean;
  // AUT-04: whether the plan has quotes / documents (their triggers are offered only then)
  quotes?: boolean;
  documents?: boolean;
  // AUT-02 (rest): the business's quote templates, for a "create quote" step (read only with the quotes flag)
  quoteTemplates?: Array<{ id: string; name: string }>;
  // AUT-03: the business's public forms, for an optional form on a "form submitted" trigger
  forms?: Array<{ id: string; name: string }>;
};

type ReadFailure = { message: string; code?: string | null };

/**
 * Everything a rule may point at, from the user's own organization (RLS), for a
 * Server Action: a failed read of the reasons comes back as `error` (FXC-05), so
 * the action can answer with a message instead of throwing.
 */
export async function readLookups(orgId: string): Promise<{ data: Lookups; error: null } | { data: null; error: ReadFailure }> {
  const supabase = await createClient();
  let fields: Lookups["fields"];
  let payments: boolean;
  let quotes: boolean;
  let documents: boolean;
  try {
    const [[lead, contact, company, deal], hasPayments, hasQuotes, hasDocuments] = await Promise.all([
      Promise.all((["lead", "contact", "company", "deal"] as const).map((type) => listFieldDefinitions(orgId, type))),
      orgHasFeature(orgId, "payments"),
      orgHasFeature(orgId, "quotes"),
      orgHasFeature(orgId, "documents"),
    ]);
    fields = { lead, contact, company, deal };
    payments = hasPayments;
    quotes = hasQuotes;
    documents = hasDocuments;
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : "field definitions query failed" } };
  }
  const [statuses, sources, pipelines, stages, tags, members, teams, reasons, terms, templates, forms] = await Promise.all([
    supabase.from("lead_statuses").select("id, name, kind").eq("organization_id", orgId).order("position"),
    supabase.from("lead_sources").select("id, name").eq("organization_id", orgId).eq("is_active", true).order("name"),
    supabase.from("pipelines").select("id, name").eq("organization_id", orgId).is("deleted_at", null).order("position"),
    supabase.from("stages").select("id, name, pipeline_id, kind").eq("organization_id", orgId).order("position"),
    listTags(orgId),
    listMembers(orgId),
    listTeams(orgId),
    supabase
      .from("disqualify_reasons")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true }),
    getOrgTerms(orgId),
    quotes
      ? supabase.from("quote_templates").select("id, name").eq("organization_id", orgId).order("name").order("id").limit(1000)
      : Promise.resolve({ data: [] as Array<{ id: string; name: string }>, error: null }),
    // AUT-03: web forms only (a business card's or a site widget's form is not picked by name)
    supabase.from("forms").select("id, name").eq("organization_id", orgId).eq("kind", "form").order("name").order("id").limit(1000),
  ]);
  if (reasons.error) {
    return { data: null, error: reasons.error };
  }
  if (templates.error) {
    return { data: null, error: templates.error };
  }
  if (forms.error) {
    return { data: null, error: forms.error };
  }
  return {
    data: {
      statuses: statuses.data ?? [],
      sources: sources.data ?? [],
      tags,
      pipelines: (pipelines.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        stages: (stages.data ?? []).filter((s) => s.pipeline_id === p.id).map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
      })),
      members: members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ id: m.userId, name: m.name })),
      teams: teams.map((t) => ({ id: t.id, name: t.name })),
      reasons: reasons.data ?? [],
      fields,
      dealWord: terms.deal.singular,
      payments,
      quotes,
      documents,
      quoteTemplates: templates.data ?? [],
      forms: forms.data ?? [],
    },
    error: null,
  };
}

/** The same for a page: a failed read throws (FXC-05, error.tsx shows). */
export async function getLookups(orgId: string): Promise<Lookups> {
  return must(await readLookups(orgId), "automation lookups");
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
  // PRM-01: who made the rule and who changed it last (server-set)
  createdBy: string | null;
  updatedBy: string | null;
};

function objects(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)) : [];
}

export async function listAutomations(orgId: string): Promise<AutomationSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automations")
    .select("id, name, is_active, template_key, entity_type, trigger_type, trigger_config, conditions, actions, created_by, updated_by")
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
    createdBy: row.created_by,
    updatedBy: row.updated_by,
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
  steps: Array<{
    action: string | null;
    status: string;
    error?: string;
    warning?: string;
    warnings?: string[];
    warningName?: string;
    warningCount?: number;
    attempt?: number;
  }>;
  // AUT-06: retries of the failed steps
  retryCount: number;
  nextRetryAt: string | null;
  retryNote: string | null;
};

export async function listRuns(orgId: string, automationId: string): Promise<RunItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("automation_runs")
    .select("id, status, entity_type, entity_id, created_at, steps, retry_count, next_retry_at, retry_note")
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
      warning: typeof s.warning === "string" ? s.warning : undefined,
      warnings: Array.isArray(s.warnings) ? s.warnings.filter((w): w is string => typeof w === "string") : undefined,
      warningName: typeof s.warning_name === "string" ? s.warning_name : undefined,
      warningCount: typeof s.warning_count === "number" ? s.warning_count : undefined,
      attempt: typeof s.attempt === "number" ? s.attempt : undefined,
    })),
    retryCount: row.retry_count ?? 0,
    nextRetryAt: row.next_retry_at ?? null,
    retryNote: row.retry_note ?? null,
  }));
}

/** Recent records of a type, to pick one for a test run. */
export async function listTestRecords(orgId: string, entity: string): Promise<Array<{ id: string; name: string }>> {
  const supabase = await createClient();
  const table = RECORD_TYPES[entity as "lead"].table;
  if (!table) {
    return [];
  }
  const column = entity === "task" ? "title" : entity === "company" || entity === "deal" ? "name" : "full_name";
  const data = must(await supabase
    .from(table as "leads")
    .select(`id, ${column}`)
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(30), "data");
  return ((data ?? []) as unknown as Array<Record<string, string | null>>).map((row) => ({ id: String(row.id), name: row[column] || "ללא שם" }));
}

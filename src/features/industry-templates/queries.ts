import "server-only";

import { orgHasFeature } from "@/features/settings/queries";
import { must } from "@/lib/db-read";
import { readAllPages } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { INDUSTRY_TEMPLATES, previewTemplate, type ExistingLists, type TemplatePreview } from "./templates";

/** The organization's lists the templates are compared with (names only). */
export async function getExistingLists(orgId: string): Promise<ExistingLists> {
  const supabase = await createClient();
  const [pipelines, stages, statuses, sources, fields, automations, products] = await Promise.all([
    supabase.from("pipelines").select("id, name").eq("organization_id", orgId).is("deleted_at", null).order("position").order("created_at"),
    supabase.from("stages").select("pipeline_id, name, kind").eq("organization_id", orgId).order("position").order("id"),
    supabase.from("lead_statuses").select("name").eq("organization_id", orgId).order("id"),
    supabase.from("lead_sources").select("name").eq("organization_id", orgId).order("id"),
    supabase.from("field_definitions").select("object_type, key, label").eq("organization_id", orgId).order("id"),
    supabase.from("automations").select("name, template_key").eq("organization_id", orgId).order("id"),
    // FLD-05 sample products: only with the product catalog in the plan; every product's name, archived ones too
    orgHasFeature(orgId, "products").then(async (enabled) =>
      enabled
        ? (
            await readAllPages(async (from, to) =>
              must(await supabase.from("products").select("name").eq("organization_id", orgId).order("id").range(from, to), "products"),
            )
          ).rows.map((p) => p.name)
        : null,
    ),
  ]);
  const stageRows = must(stages, "stages");
  return {
    pipelines: must(pipelines, "pipelines").map((p) => ({
      name: p.name,
      stages: stageRows.filter((s) => s.pipeline_id === p.id).map((s) => ({ name: s.name, kind: s.kind })),
    })),
    statuses: must(statuses, "lead_statuses").map((s) => s.name),
    sources: must(sources, "lead_sources").map((s) => s.name),
    fields: must(fields, "field_definitions"),
    automations: must(automations, "automations"),
    products,
  };
}

/** What each template would add to the organization now, by industry key. */
export async function getTemplatePreviews(orgId: string): Promise<Record<string, TemplatePreview>> {
  const existing = await getExistingLists(orgId);
  return Object.fromEntries(INDUSTRY_TEMPLATES.map((t) => [t.industry, previewTemplate(t, existing)]));
}

/** The industry templates already applied to the organization (keys). */
export async function getAppliedTemplates(orgId: string): Promise<string[]> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("organizations").select("industry_templates").eq("id", orgId).maybeSingle(),
    "organizations.industry_templates",
  );
  return row?.industry_templates ?? [];
}

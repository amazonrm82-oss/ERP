import "server-only";

import { orgHasFeature } from "@/features/settings/queries";
import { must } from "@/lib/db-read";
import { readAllPages } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { ALL_TEMPLATES, previewAny, type AnyTemplatePreview, type KitExisting } from "./kits";
import type { ExistingLists } from "./templates";

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

/** VRT-01: the organization's names the kits' extras are compared with. */
export async function getKitExisting(orgId: string): Promise<KitExisting> {
  const supabase = await createClient();
  const [meetingTypes, messageTemplates, whatsappTemplates, forms, views, punchCards] = await Promise.all([
    supabase.from("meeting_types").select("name").eq("organization_id", orgId).order("id"),
    supabase.from("message_templates").select("name").eq("organization_id", orgId).order("id"),
    supabase.from("whatsapp_templates").select("name").eq("organization_id", orgId).order("id"),
    supabase.from("forms").select("name").eq("organization_id", orgId).order("id"),
    supabase.from("saved_views").select("name").eq("organization_id", orgId).eq("object_type", "lead").eq("scope", "org").order("id"),
    orgHasFeature(orgId, "punch_cards"),
  ]);
  return {
    meetingTypes: must(meetingTypes, "meeting_types").map((r) => r.name),
    messageTemplates: must(messageTemplates, "message_templates").map((r) => r.name),
    whatsappTemplates: must(whatsappTemplates, "whatsapp_templates").map((r) => r.name),
    forms: must(forms, "forms").map((r) => r.name),
    leadViews: must(views, "saved_views").map((r) => r.name),
    punchCards,
  };
}

/** What each template and kit would add to the organization now, by key. */
export async function getTemplatePreviews(orgId: string): Promise<Record<string, AnyTemplatePreview>> {
  const [existing, kitExisting] = await Promise.all([getExistingLists(orgId), getKitExisting(orgId)]);
  const entries: Array<[string, AnyTemplatePreview]> = [];
  for (const t of ALL_TEMPLATES) {
    const result = previewAny(t.industry, existing, kitExisting);
    if (result) entries.push([t.industry, result]);
  }
  return Object.fromEntries(entries);
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

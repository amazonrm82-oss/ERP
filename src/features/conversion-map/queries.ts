import "server-only";

import { listFieldDefinitions } from "@/features/custom-fields/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { isMapMode, isMapTarget, targetHideWarning, type MapField, type MapRow, type MapTarget } from "./rules";

export type ConversionMapData = {
  leadFields: MapField[];
  targets: Record<MapTarget, MapField[]>;
  rows: MapRow[];
};

const asMapField = (f: { id: string; label: string; type: string; isActive: boolean }): MapField => ({
  id: f.id,
  label: f.label,
  type: f.type,
  isActive: f.isActive,
});

/** LEAD-06: the lead custom fields, the contact and deal fields, and the stored mapping (everyone in the organization reads it). */
export async function getConversionMap(orgId: string): Promise<ConversionMapData> {
  const supabase = await createClient();
  const [lead, contact, deal, result] = await Promise.all([
    listFieldDefinitions(orgId, "lead", { includeInactive: true }),
    listFieldDefinitions(orgId, "contact", { includeInactive: true }),
    listFieldDefinitions(orgId, "deal", { includeInactive: true }),
    supabase
      .from("conversion_field_maps")
      .select("id, lead_field_id, target_type, mode, target_field_id, target_removed")
      .eq("organization_id", orgId)
      .order("id", { ascending: true }),
  ]);
  const rows = must(result, "conversion_field_maps");
  return {
    leadFields: lead.map(asMapField),
    targets: { contact: contact.map(asMapField), deal: deal.map(asMapField) },
    rows: rows.flatMap((r) =>
      isMapTarget(r.target_type) && isMapMode(r.mode)
        ? [{ id: r.id, leadFieldId: r.lead_field_id, targetType: r.target_type, mode: r.mode, targetFieldId: r.target_field_id, targetRemoved: r.target_removed }]
        : [],
    ),
  };
}

/** LEAD-06: whether a picked target was deleted and nobody chose again (drives the reminder on the settings page). */
export async function conversionMapNeedsFix(orgId: string): Promise<boolean> {
  const supabase = await createClient();
  const result = await supabase
    .from("conversion_field_maps")
    .select("id")
    .eq("organization_id", orgId)
    .eq("target_removed", true)
    .limit(1);
  return must(result, "conversion_field_maps removed targets").length > 0;
}

/**
 * LEAD-06: for the fields settings page, the question to ask before hiding each
 * contact or deal field a lead field picked by hand (by target field id). Read
 * with the user's session; a field nobody picked has no entry.
 */
export async function hideWarningsFor(orgId: string, type: MapTarget): Promise<Record<string, string>> {
  const supabase = await createClient();
  const result = await supabase
    .from("conversion_field_maps")
    .select("lead_field_id, target_field_id")
    .eq("organization_id", orgId)
    .eq("target_type", type)
    .eq("mode", "field")
    .order("id", { ascending: true });
  const rows = must(result, "conversion_field_maps targets");
  if (rows.length === 0) return {};
  const leads = await listFieldDefinitions(orgId, "lead", { includeInactive: true });
  const warnings: Record<string, string> = {};
  for (const row of rows) {
    const lead = leads.find((f) => f.id === row.lead_field_id);
    if (row.target_field_id && lead) warnings[row.target_field_id] = targetHideWarning(lead.label, type);
  }
  return warnings;
}

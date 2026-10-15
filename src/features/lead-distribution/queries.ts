import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { distributionSettingsFrom, type DistributionSettings, type RoutingRule } from "./settings";

export type NamedOption = { id: string; name: string };
// A list field of leads and its options (a rule's field condition; the stand-in for area until BRN-02)
export type ListField = { key: string; label: string; options: string[]; active: boolean };

/** The business's distribution method and weights (CAP-08); members read it, no row = round robin. */
export async function getDistributionSettings(orgId: string): Promise<DistributionSettings> {
  const supabase = await createClient();
  const row = must(
    await supabase.from("lead_distribution_settings").select("method, weights").eq("organization_id", orgId).maybeSingle(),
    "lead distribution settings",
  );
  return distributionSettingsFrom(row);
}

/** The rules in their order (at most 50 per business). */
export async function listRoutingRules(orgId: string): Promise<RoutingRule[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("lead_routing_rules")
      .select("id, position, is_active, source_id, product_id, locale, field_key, field_value, team_id, user_id")
      .eq("organization_id", orgId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
    "lead routing rules",
  );
  return rows.map((row) => ({
    id: row.id,
    position: row.position,
    isActive: row.is_active,
    sourceId: row.source_id,
    productId: row.product_id,
    locale: row.locale,
    fieldKey: row.field_key,
    fieldValue: row.field_value,
    teamId: row.team_id,
    userId: row.user_id,
  }));
}

/**
 * What a rule can name: the lead sources and teams, and the products a rule may ask for
 * (offerable ones, by name; at most 1,000, the PostgREST page) plus any product a rule
 * already names, so its name still shows.
 */
export async function getRuleChoices(
  orgId: string,
  rules: RoutingRule[],
): Promise<{ sources: NamedOption[]; teams: NamedOption[]; products: NamedOption[]; fields: ListField[] }> {
  const supabase = await createClient();
  const named = [...new Set(rules.map((rule) => rule.productId).filter((id): id is string => id !== null))];
  const [sources, teams, products, namedProducts, fields] = await Promise.all([
    supabase.from("lead_sources").select("id, name").eq("organization_id", orgId).order("name").order("id").then((r) => must(r, "lead sources")),
    supabase.from("teams").select("id, name").eq("organization_id", orgId).order("name").order("id").then((r) => must(r, "teams")),
    supabase
      .from("products")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .is("archived_at", null)
      .order("name")
      .order("id")
      .limit(1000)
      .then((r) => must(r, "products")),
    named.length > 0
      ? supabase.from("products").select("id, name").eq("organization_id", orgId).in("id", named).then((r) => must(r, "rule products"))
      : Promise.resolve([] as NamedOption[]),
    supabase
      .from("field_definitions")
      .select("key, label, options, is_active")
      .eq("organization_id", orgId)
      .eq("object_type", "lead")
      .eq("field_type", "select")
      .order("position")
      .order("id")
      .then((r) => must(r, "lead list fields")),
  ]);
  const productMap = new Map<string, NamedOption>();
  for (const product of [...products, ...namedProducts]) productMap.set(product.id, { id: product.id, name: product.name });
  return {
    sources: sources.map((s) => ({ id: s.id, name: s.name })),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    products: [...productMap.values()],
    fields: fields.map((f) => ({
      key: f.key,
      label: f.label,
      options: Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === "string") : [],
      active: f.is_active,
    })),
  };
}

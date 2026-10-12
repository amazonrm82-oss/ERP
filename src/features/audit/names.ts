import "server-only";

import { getUserNames } from "@/features/shell/queries";
import { createClient } from "@/lib/supabase/server";

/** Names for ids that appear in audit changes: users, statuses, sources, stages, pipelines, teams, companies, deals, contacts, record types, meetings. */
export async function nameIds(orgId: string, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const supabase = await createClient();
  const [users, statuses, sources, stages, pipelines, teams, companies, deals, contacts, types, meetings] = await Promise.all([
    getUserNames(ids),
    supabase.from("lead_statuses").select("id, name").eq("organization_id", orgId).in("id", ids),
    supabase.from("lead_sources").select("id, name").eq("organization_id", orgId).in("id", ids),
    supabase.from("stages").select("id, name").eq("organization_id", orgId).in("id", ids),
    supabase.from("pipelines").select("id, name").eq("organization_id", orgId).in("id", ids),
    supabase.from("teams").select("id, name").eq("organization_id", orgId).in("id", ids),
    supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", ids),
    supabase.from("deals").select("id, name").eq("organization_id", orgId).in("id", ids),
    supabase.from("contacts").select("id, full_name").eq("organization_id", orgId).in("id", ids),
    // CON-02
    supabase.from("record_type_options").select("id, name").eq("organization_id", orgId).in("id", ids),
    // CAL-01: a participant entry names its meeting
    supabase.from("meetings").select("id, title").eq("organization_id", orgId).in("id", ids),
  ]);
  for (const [id, name] of users) names.set(id, name);
  for (const result of [statuses, sources, stages, pipelines, teams, companies, deals, types]) {
    for (const row of result.data ?? []) names.set(row.id, row.name);
  }
  for (const row of contacts.data ?? []) names.set(row.id, row.full_name ?? "איש קשר");
  for (const row of meetings.data ?? []) names.set(row.id, row.title);
  return names;
}

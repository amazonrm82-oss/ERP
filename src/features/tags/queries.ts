import "server-only";

import { createClient } from "@/lib/supabase/server";

export type TagOption = { id: string; name: string };

/** The organization's tags, by name. */
export async function listTags(orgId: string): Promise<TagOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("tags").select("id, name").eq("organization_id", orgId).order("name", { ascending: true });
  if (error) {
    throw new Error(`tags query failed: ${error.message}`);
  }
  return data;
}

/** Tags of a record, in name order. Ids of deleted tags are skipped. */
export function tagsOf(all: TagOption[], tagIds: string[] | null | undefined): TagOption[] {
  const ids = new Set(tagIds ?? []);
  return all.filter((tag) => ids.has(tag.id));
}

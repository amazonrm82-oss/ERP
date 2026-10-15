import "server-only";

import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

export type TagOption = { id: string; name: string; color: string | null };

/** The organization's tags, by name. */
// Memoized per request (FXC-09): a list page, its filter and its table cells ask for it several times.
export const listTags = cache(async (orgId: string): Promise<TagOption[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("tags").select("id, name, color").eq("organization_id", orgId).order("name", { ascending: true });
  if (error) {
    throw new Error(`tags query failed: ${error.message}`);
  }
  return data;
});

/** Tags of a record, in name order. Ids of deleted tags are skipped. */
export function tagsOf(all: TagOption[], tagIds: string[] | null | undefined): TagOption[] {
  const ids = new Set(tagIds ?? []);
  return all.filter((tag) => ids.has(tag.id));
}

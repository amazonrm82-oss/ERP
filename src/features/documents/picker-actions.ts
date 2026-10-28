"use server";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery, SEARCH_PICKER_MAX_HITS } from "@/components/ui/search-picker-logic";
import { actionContext } from "@/lib/action-context";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { personSearchFilter } from "@/lib/search";

// DOC-03: the documents list's company filter: live companies whose name holds the query, read with the user's session (RLS
// decides what is found), at most SEARCH_PICKER_MAX_HITS by name.

export async function searchDocumentCompaniesAction(orgId: string, query: string): Promise<SearchPickerResult> {
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") return { hits: [] };
  const term = pickerQuery(query);
  if (term === null) return { hits: [] };
  const filter = personSearchFilter(term);
  if (!filter) return { hits: [] };
  const context = await actionContext(orgId);
  if (!context.ok) return { error: context.message };
  const { data, error } = await context.supabase
    .from("companies")
    .select("id, name, city")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .or(filter)
    .order("name", { ascending: true })
    .order("id")
    .limit(SEARCH_PICKER_MAX_HITS);
  if (error) return { error: "החיפוש נכשל. נסו שוב." };
  return { hits: data.map((row) => ({ id: row.id, label: row.name, detail: row.city ?? null })) };
}

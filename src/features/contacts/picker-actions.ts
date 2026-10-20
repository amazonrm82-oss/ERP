"use server";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery, SEARCH_PICKER_MAX_HITS } from "@/components/ui/search-picker-logic";
import { actionContext } from "@/lib/action-context";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { personSearchFilter } from "@/lib/search";

import { contactHit, pickerExclude } from "./picker";

const SEARCH_FAILED = "החיפוש נכשל. נסו שוב.";

/**
 * The contact search picker: live contacts whose name, email (search_text, folded like every list search) or phone holds
 * the query, read with the user's session (RLS decides what is found), at most SEARCH_PICKER_MAX_HITS by name. `exclude`
 * leaves out ids the form cannot take again (a deal's linked contacts, the contact itself).
 */
export async function searchContactsAction(orgId: string, query: string, exclude: string[] = []): Promise<SearchPickerResult> {
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") {
    return { hits: [] };
  }
  const term = pickerQuery(query);
  const skip = pickerExclude(exclude);
  if (term === null || skip === null) {
    return { hits: [] };
  }
  const filter = personSearchFilter(term);
  if (!filter) {
    return { hits: [] };
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return { error: context.message };
  }
  let request = context.supabase
    .from("contacts")
    .select("id, full_name, email, phone")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .or(filter);
  if (skip.length > 0) {
    request = request.not("id", "in", `(${skip.join(",")})`);
  }
  const { data, error } = await request.order("full_name", { ascending: true }).order("id").limit(SEARCH_PICKER_MAX_HITS);
  if (error) {
    return { error: SEARCH_FAILED };
  }
  return { hits: data.map(contactHit) };
}

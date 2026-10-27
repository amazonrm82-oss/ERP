"use server";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery } from "@/components/ui/search-picker-logic";
import { getOrgModules } from "@/features/modules/queries";
import { getOrgTerms } from "@/features/terminology/queries";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";

import { shareSearchHits, type SearchRecordsAnswer } from "./records";

const SEARCH_FAILED = "החיפוש נכשל. נסו שוב.";

/**
 * WAB-06: the record picker of "הערה לרשומה". The global search (public.search_records, security invoker: RLS decides
 * what is found) with the user's session; leads, contacts, companies and deals only, switched-off modules left out.
 * A hit's id is "<kind>:<uuid>"; the note is saved by addNoteAction, which checks the rights again.
 */
export async function searchShareRecordsAction(orgId: string, query: string): Promise<SearchPickerResult> {
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") {
    return { hits: [] };
  }
  const term = pickerQuery(query);
  if (term === null) {
    return { hits: [] };
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return { error: context.message };
  }
  const { data, error } = await context.supabase.rpc("search_records", { p_org: orgId, p_query: term, p_limit: 6 });
  if (error) {
    return { error: SEARCH_FAILED };
  }
  const [modules, terms] = await Promise.all([getOrgModules(orgId), getOrgTerms(orgId)]);
  return { hits: shareSearchHits(data as SearchRecordsAnswer, modules, terms) };
}

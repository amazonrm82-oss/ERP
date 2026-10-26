"use server";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery, SEARCH_PICKER_MAX_HITS } from "@/components/ui/search-picker-logic";
import { contactHit } from "@/features/contacts/picker";
import { actionContext } from "@/lib/action-context";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { RECORD_TYPES } from "@/lib/record-types";
import { personSearchFilter, textSearchFilter } from "@/lib/search";

import { isLinkTarget } from "./types";

const SEARCH_FAILED = "החיפוש נכשל. נסו שוב.";

/**
 * FLD-06 part B: the picker of a record link field. Live records of the field's target type whose name (search_text,
 * folded like every list search; for leads and contacts also the phone) holds the query, read with the user's session
 * (RLS decides what is found), at most SEARCH_PICKER_MAX_HITS by name. The database judges the pick again.
 */
export async function searchRecordLinkAction(orgId: string, target: string, query: string): Promise<SearchPickerResult> {
  if (!isLinkTarget(target) || !validArg(optionalTextArg(100), query) || typeof query !== "string") {
    return { hits: [] };
  }
  const term = pickerQuery(query);
  if (term === null) {
    return { hits: [] };
  }
  const person = target === "lead" || target === "contact";
  const filter = person ? personSearchFilter(term) : textSearchFilter(term);
  if (!filter) {
    return { hits: [] };
  }
  const context = await actionContext(orgId);
  if (!context.ok) {
    return { error: context.message };
  }
  if (person) {
    const { data, error } = await context.supabase
      .from(target === "lead" ? "leads" : "contacts")
      .select("id, full_name, email, phone")
      .eq("organization_id", orgId)
      .is("deleted_at", null)
      .or(filter)
      .order("full_name", { ascending: true })
      .order("id")
      .limit(SEARCH_PICKER_MAX_HITS);
    if (error) return { error: SEARCH_FAILED };
    return { hits: data.map(contactHit) };
  }
  const { data, error } = await context.supabase
    .from(target === "company" ? "companies" : "deals")
    .select("id, name")
    .eq("organization_id", orgId)
    .is("deleted_at", null)
    .or(filter)
    .order("name", { ascending: true })
    .order("id")
    .limit(SEARCH_PICKER_MAX_HITS);
  if (error) return { error: SEARCH_FAILED };
  return { hits: data.map((row) => ({ id: row.id, label: (row.name ?? "").trim() || RECORD_TYPES[target].singular })) };
}

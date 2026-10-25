"use server";

import type { SearchPickerResult } from "@/components/ui/search-picker";
import { pickerQuery, SEARCH_PICKER_MAX_HITS } from "@/components/ui/search-picker-logic";
import { actionContext } from "@/lib/action-context";
import { optionalTextArg, validArg } from "@/lib/action-args";
import { textSearchFilter } from "@/lib/search";

const SEARCH_FAILED = "החיפוש נכשל. נסו שוב.";

/**
 * TASK-06 part B (owner, answer (3) ב): the parent picker of a task's edit form. Open, live tasks that are not sub-tasks,
 * whose title holds the query (search_text, folded like every list search), read with the user's session (RLS decides),
 * leaving out the task itself; its own sub-tasks are sub-tasks, so they never show. The database judges the pick again.
 */
export async function searchParentTasksAction(orgId: string, taskId: string, query: string): Promise<SearchPickerResult> {
  if (!validArg(optionalTextArg(100), query) || typeof query !== "string") {
    return { hits: [] };
  }
  const term = pickerQuery(query);
  if (term === null) {
    return { hits: [] };
  }
  const filter = textSearchFilter(term);
  if (!filter) {
    return { hits: [] };
  }
  const context = await actionContext(orgId, taskId);
  if (!context.ok) {
    return { error: context.message };
  }
  const { data, error } = await context.supabase
    .from("tasks")
    .select("id, title")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .is("deleted_at", null)
    .is("parent_task_id", null)
    .neq("id", taskId)
    .or(filter)
    .order("title", { ascending: true })
    .order("id")
    .limit(SEARCH_PICKER_MAX_HITS);
  if (error) {
    return { error: SEARCH_FAILED };
  }
  return { hits: data.map((row) => ({ id: row.id, label: row.title })) };
}

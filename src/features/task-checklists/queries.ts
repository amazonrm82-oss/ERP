import "server-only";

import { cache } from "react";

import { must } from "@/lib/db-read";
import { readAllPagesByIds } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import type { ChecklistStep } from "./templates";

export type ChecklistTemplate = { id: string; name: string; steps: string[] };

/** The business's checklist templates, in their order; every member reads them. Memoized per request. */
export const listChecklistTemplates = cache(async (orgId: string): Promise<ChecklistTemplate[]> => {
  const supabase = await createClient();
  const rows = must(
    await supabase.from("checklist_templates").select("id, name, steps").eq("organization_id", orgId).order("position").order("name").order("id"),
    "checklist_templates",
  );
  return rows.map((row) => ({ id: row.id, name: row.name, steps: row.steps }));
});

/** The steps of these tasks, by task, in order. A step is read only with its task (RLS). */
export async function listChecklistSteps(orgId: string, taskIds: string[]): Promise<Map<string, ChecklistStep[]>> {
  const byTask = new Map<string, ChecklistStep[]>();
  if (taskIds.length === 0) return byTask;
  const supabase = await createClient();
  const rows = await readAllPagesByIds(taskIds, async (slice, from, to) =>
    must(
      await supabase
        .from("task_checklist_items")
        .select("id, task_id, title, done, position")
        .eq("organization_id", orgId)
        .in("task_id", slice)
        .order("task_id")
        .order("position")
        .order("id")
        .range(from, to),
      "task_checklist_items",
    ),
  );
  for (const row of rows) {
    const list = byTask.get(row.task_id) ?? [];
    list.push({ id: row.id, title: row.title, done: row.done, position: row.position });
    byTask.set(row.task_id, list);
  }
  return byTask;
}

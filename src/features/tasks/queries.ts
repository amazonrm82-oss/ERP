import "server-only";

import { getUserNames } from "@/features/shell/queries";
import { zoneDate, zonedIso } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export type TaskItem = {
  id: string;
  title: string;
  dueAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  taskType: string;
  completedAt: string | null;
  // the record the task belongs to, when there is one
  related: { kind: "lead" | "contact" | "company" | "deal"; id: string } | null;
};

export type TaskGroups = {
  overdue: TaskItem[];
  today: TaskItem[];
  upcoming: TaskItem[];
  undated: TaskItem[];
  done: TaskItem[];
  // true when more open tasks exist than were loaded
  truncated: boolean;
};

const OPEN_LIMIT = 300;
const DONE_SHOWN = 20;

/**
 * Open tasks grouped by due date (organization time zone), plus the latest
 * completed ones. `ownerId` limits the list to one assignee; without it, every
 * task the user may see (RLS decides).
 */
export async function listTaskGroups(orgId: string, ownerId: string | null): Promise<TaskGroups> {
  const supabase = await createClient();
  const columns = "id, title, task_type, due_at, owner_id, completed_at, lead_id, contact_id, company_id, deal_id";

  let open = supabase.from("tasks").select(columns).eq("organization_id", orgId).eq("status", "open").is("deleted_at", null);
  let done = supabase.from("tasks").select(columns).eq("organization_id", orgId).eq("status", "done").is("deleted_at", null);
  if (ownerId) {
    open = open.eq("owner_id", ownerId);
    done = done.eq("owner_id", ownerId);
  }

  const [openResult, doneResult] = await Promise.all([
    open.order("due_at", { ascending: true, nullsFirst: false }).order("created_at", { ascending: true }).limit(OPEN_LIMIT + 1),
    done.order("completed_at", { ascending: false }).limit(DONE_SHOWN),
  ]);
  if (openResult.error) {
    throw new Error(`tasks query failed: ${openResult.error.message}`);
  }
  if (doneResult.error) {
    throw new Error(`done tasks query failed: ${doneResult.error.message}`);
  }

  const openRows = openResult.data.slice(0, OPEN_LIMIT);
  const owners = await getUserNames([...openRows, ...doneResult.data].map((row) => row.owner_id));
  const toItem = (row: (typeof openRows)[number]): TaskItem => ({
    id: row.id,
    title: row.title,
    dueAt: row.due_at,
    ownerId: row.owner_id,
    ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
    taskType: row.task_type,
    completedAt: row.completed_at,
    related: row.deal_id
      ? { kind: "deal", id: row.deal_id }
      : row.lead_id
        ? { kind: "lead", id: row.lead_id }
        : row.contact_id
          ? { kind: "contact", id: row.contact_id }
          : row.company_id
            ? { kind: "company", id: row.company_id }
            : null,
  });

  const today = zoneDate(new Date());
  // compared as numbers: PostgREST writes "+00:00", toISOString() writes "Z"
  const startOfToday = Date.parse(zonedIso(today, "00:00:00"));
  const endOfToday = Date.parse(zonedIso(today, "23:59:59.999"));
  const groups: TaskGroups = { overdue: [], today: [], upcoming: [], undated: [], done: [], truncated: openResult.data.length > OPEN_LIMIT };
  for (const row of openRows) {
    const item = toItem(row);
    const due = item.dueAt ? Date.parse(item.dueAt) : null;
    if (due === null) groups.undated.push(item);
    else if (due < startOfToday) groups.overdue.push(item);
    else if (due <= endOfToday) groups.today.push(item);
    else groups.upcoming.push(item);
  }
  groups.done = doneResult.data.map(toItem);
  return groups;
}

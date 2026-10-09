import "server-only";

import { getUserNames } from "@/features/shell/queries";
import type { TaskStatus } from "@/lib/database.types";
import { zoneDate, zonedIso } from "@/lib/format";
import { ilikeAny, PAGE_SIZE } from "@/lib/search";
import { sortColumn, type Sort } from "@/lib/sort";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type TaskItem = {
  id: string;
  title: string;
  dueAt: string | null;
  remindAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  taskType: string;
  priority: number;
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
  const columns = "id, title, task_type, priority, due_at, remind_at, owner_id, completed_at, lead_id, contact_id, company_id, deal_id";

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
    remindAt: row.remind_at,
    ownerId: row.owner_id,
    ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
    taskType: row.task_type,
    priority: row.priority,
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
  // TASK-01: within a group, high priority first; the due order stays among equals (a stable sort)
  for (const key of ["overdue", "today", "upcoming", "undated"] as const) groups[key].sort((a, b) => a.priority - b.priority);
  return groups;
}

export type TaskListItem = {
  id: string;
  title: string;
  taskType: string;
  status: TaskStatus;
  priority: number;
  dueAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  related: { kind: "lead" | "contact" | "company" | "deal"; id: string; name: string | null } | null;
  createdAt: string;
};

// columns the tasks table can be sorted by (LST-09); owner is a computed field (migration 0035)
export const TASK_SORT_COLUMNS = {
  title: "title",
  due: "due_at",
  type: "task_type",
  status: "status",
  priority: "priority",
  owner: "sort_owner",
  created: "created_at",
} as const;
export type TaskSortKey = keyof typeof TASK_SORT_COLUMNS;
export const TASK_DEFAULT_SORT: Sort<TaskSortKey> = { key: "due", ascending: true };

/**
 * One page of live tasks as a table (LST-09), by due date unless sorted
 * otherwise. `ownerId` limits it to one assignee; without it, every task the
 * user may see (RLS decides). Fetches one extra row to know if there is a next page.
 */
export async function listTasks(
  orgId: string,
  options: {
    ownerId: string | null;
    search: string;
    page: number;
    sort?: Sort<TaskSortKey>;
    filter?: string | null;
    ids?: string[];
    chunk?: { from: number; size: number };
  },
): Promise<{ tasks: TaskListItem[]; hasMore: boolean }> {
  const supabase = await createClient();
  const size = options.chunk?.size ?? PAGE_SIZE;
  const from = options.chunk?.from ?? (options.page - 1) * PAGE_SIZE;

  let query = supabase
    .from("tasks")
    .select("id, title, task_type, status, priority, due_at, owner_id, lead_id, contact_id, company_id, deal_id, created_at")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  if (options.ownerId) {
    query = query.eq("owner_id", options.ownerId);
  }
  const searchFilter = ilikeAny(["title"], options.search);
  if (searchFilter) {
    query = query.or(searchFilter);
  }
  if (options.ids) {
    query = query.in("id", options.ids);
  }
  if (options.filter) {
    query = query.or(options.filter);
  }
  const sort = options.sort ?? TASK_DEFAULT_SORT;
  const { data, error } = await query
    .order(sortColumn(TASK_SORT_COLUMNS, sort.key), { ascending: sort.ascending, nullsFirst: false })
    .order("id", { ascending: sort.ascending })
    .range(from, from + size);
  if (error) {
    throw new Error(`tasks query failed: ${error.message}`);
  }
  const rows = data.slice(0, size);

  const [owners, related] = await Promise.all([getUserNames(rows.map((row) => row.owner_id)), relatedRecords(orgId, rows)]);

  return {
    hasMore: data.length > size,
    tasks: rows.map((row) => {
      return {
        id: row.id,
        title: row.title,
        taskType: row.task_type,
        status: row.status,
        priority: row.priority,
        dueAt: row.due_at,
        ownerId: row.owner_id,
        ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
        related: related(row),
        createdAt: row.created_at,
      };
    }),
  };
}

type LinkColumns = { lead_id: string | null; contact_id: string | null; company_id: string | null; deal_id: string | null };
export type RelatedRecord = { kind: "lead" | "contact" | "company" | "deal"; id: string; name: string | null };

/**
 * The record each task belongs to, with its name (one query per kind, read
 * with the user's rights). A record the user may not see comes back without a name.
 */
export async function relatedRecords(orgId: string, rows: LinkColumns[]): Promise<(row: LinkColumns) => RelatedRecord | null> {
  const supabase = await createClient();
  const idsOf = (column: keyof LinkColumns) => [...new Set(rows.map((row) => row[column]).filter((id): id is string => Boolean(id)))];
  const [leadIds, contactIds, companyIds, dealIds] = [idsOf("lead_id"), idsOf("contact_id"), idsOf("company_id"), idsOf("deal_id")];
  const none = Promise.resolve({ data: [] as Array<Record<string, string | null>>, error: null });
  const [leads, contacts, companies, deals] = await Promise.all([
    leadIds.length > 0 ? supabase.from("leads").select("id, full_name, email, phone").eq("organization_id", orgId).in("id", leadIds) : none,
    contactIds.length > 0 ? supabase.from("contacts").select("id, full_name, email, phone").eq("organization_id", orgId).in("id", contactIds) : none,
    companyIds.length > 0 ? supabase.from("companies").select("id, name").eq("organization_id", orgId).in("id", companyIds) : none,
    dealIds.length > 0 ? supabase.from("deals").select("id, name").eq("organization_id", orgId).in("id", dealIds) : none,
  ]);
  const names = new Map<string, string>();
  for (const row of [...(leads.data ?? []), ...(contacts.data ?? [])] as Array<{ id: string; full_name: string | null; email: string | null; phone: string | null }>) {
    names.set(row.id, row.full_name || row.email || row.phone || "ללא שם");
  }
  for (const row of [...(companies.data ?? []), ...(deals.data ?? [])] as Array<{ id: string; name: string }>) {
    names.set(row.id, row.name);
  }
  return (row) => {
    const link = row.deal_id
      ? { kind: "deal" as const, id: row.deal_id }
      : row.lead_id
        ? { kind: "lead" as const, id: row.lead_id }
        : row.contact_id
          ? { kind: "contact" as const, id: row.contact_id }
          : row.company_id
            ? { kind: "company" as const, id: row.company_id }
            : null;
    return link ? { ...link, name: names.get(link.id) ?? null } : null;
  };
}

export type RecordTask = { id: string; title: string; dueAt: string | null; isOverdue: boolean; ownerName: string | null };

/** The open tasks of one record (FXU-01), nearest due first; tasks without a date last. */
export async function listRecordTasks(orgId: string, column: keyof LinkColumns, recordId: string): Promise<RecordTask[]> {
  const supabase = await createClient();
  const data = must(
    await supabase
      .from("tasks")
      .select("id, title, due_at, owner_id")
      .eq("organization_id", orgId)
      .eq(column, recordId)
      .eq("status", "open")
      .is("deleted_at", null)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(50),
    "record tasks",
  );
  const owners = await getUserNames(data.map((row) => row.owner_id));
  // "באיחור" means from a day before today, as in "היום שלי"
  const startOfToday = Date.parse(zonedIso(zoneDate(new Date()), "00:00:00"));
  return data.map((row) => ({
    id: row.id,
    title: row.title,
    dueAt: row.due_at,
    isOverdue: row.due_at !== null && Date.parse(row.due_at) < startOfToday,
    ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
  }));
}

import "server-only";

import { listActivityTypes } from "@/features/activity-types/queries";
import { taskTypeName } from "@/features/activity-types/types";
import { getUserNames } from "@/features/shell/queries";
import type { LeaveKind } from "@/features/work-hours/leave";
import { getCurrentAbsences } from "@/features/work-hours/queries";
import type { TaskStatus } from "@/lib/database.types";
import { zoneDate, zonedIso } from "@/lib/format";
import { PAGE_SIZE, textSearchFilter } from "@/lib/search";
import { sortColumn, type Sort } from "@/lib/sort";
import { must } from "@/lib/db-read";
import { readAllPagesByIds } from "@/lib/paged-read";
import { createClient } from "@/lib/supabase/server";

import { parseRecurrence, type Recurrence } from "./recurrence";
import { teamsForTaskRights } from "./team-rights";

export type TaskItem = {
  id: string;
  title: string;
  dueAt: string | null;
  remindAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  // TASK-07: the task's team; with no owner and still open it is a team task anyone in the team may take
  teamId: string | null;
  taskType: string;
  // TASK-08: a type of the business's list (its base kind set taskType)
  activityTypeId: string | null;
  priority: number;
  completedAt: string | null;
  // what came of it, once done (TASK-03)
  outcome: string | null;
  // how it repeats (TASK-04); null = once
  recurrence: Recurrence | null;
  // the record the task belongs to, when there is one
  related: { kind: "lead" | "contact" | "company" | "deal"; id: string } | null;
  // TASK-06 part B: the parent of a sub-task; null for a top-level task
  parentId: string | null;
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
const TASK_ITEM_COLUMNS = "id, title, task_type, activity_type_id, priority, outcome, recurrence, due_at, remind_at, owner_id, team_id, completed_at, lead_id, contact_id, company_id, deal_id, parent_task_id";

type TaskItemRow = {
  id: string;
  title: string;
  task_type: string;
  activity_type_id: string | null;
  priority: number;
  outcome: string | null;
  recurrence: unknown;
  due_at: string | null;
  remind_at: string | null;
  owner_id: string | null;
  team_id: string | null;
  completed_at: string | null;
  lead_id: string | null;
  contact_id: string | null;
  company_id: string | null;
  deal_id: string | null;
  parent_task_id: string | null;
};

function toTaskItem(row: TaskItemRow, owners: Map<string, string>): TaskItem {
  return {
    id: row.id,
    title: row.title,
    dueAt: row.due_at,
    remindAt: row.remind_at,
    ownerId: row.owner_id,
    ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
    teamId: row.team_id,
    taskType: row.task_type,
    activityTypeId: row.activity_type_id,
    priority: row.priority,
    completedAt: row.completed_at,
    outcome: row.outcome,
    recurrence: parseRecurrence(row.recurrence),
    related: row.deal_id
      ? { kind: "deal", id: row.deal_id }
      : row.lead_id
        ? { kind: "lead", id: row.lead_id }
        : row.contact_id
          ? { kind: "contact", id: row.contact_id }
          : row.company_id
            ? { kind: "company", id: row.company_id }
            : null,
    parentId: row.parent_task_id,
  };
}

/**
 * Open tasks grouped by due date (organization time zone), plus the latest
 * completed ones. `ownerId` limits the list to one assignee; without it, every
 * task the user may see (RLS decides).
 */
export async function listTaskGroups(orgId: string, ownerId: string | null): Promise<TaskGroups> {
  const supabase = await createClient();
  const columns = TASK_ITEM_COLUMNS;

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
  const toItem = (row: (typeof openRows)[number]): TaskItem => toTaskItem(row, owners);

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

export type TaskTeam = { id: string; name: string };

/**
 * TASK-07: the teams the user may give a task to with no owner and take such a task from (`teamsForTaskRights`, the rule
 * of app.may_assign_team_task), every team's name, and the user's own teams.
 */
export async function listTaskTeams(
  orgId: string,
  userId: string,
  role: string | null,
): Promise<{ assignable: TaskTeam[]; names: Map<string, string>; mine: string[]; rights: Set<string> }> {
  const supabase = await createClient();
  const [teams, membership] = await Promise.all([
    supabase.from("teams").select("id, name, parent_team_id").eq("organization_id", orgId).order("name"),
    supabase.from("team_members").select("team_id, is_manager").eq("organization_id", orgId).eq("user_id", userId),
  ]);
  const all = must(teams, "teams");
  const rows = must(membership, "team members");
  const rights = teamsForTaskRights(
    role,
    all.map((team) => ({ id: team.id, parentId: team.parent_team_id })),
    rows.map((row) => ({ teamId: row.team_id, isManager: row.is_manager })),
  );
  return {
    assignable: all.filter((team) => rights.has(team.id)).map((team) => ({ id: team.id, name: team.name })),
    names: new Map(all.map((team) => [team.id, team.name])),
    mine: rows.map((row) => row.team_id),
    rights,
  };
}

/**
 * TASK-07: open team tasks nobody took yet, of the user's teams, due first. RLS shows them to the team's members
 * until someone takes them.
 */
export async function listOpenTeamTasks(orgId: string, teamIds: string[]): Promise<TaskItem[]> {
  if (teamIds.length === 0) return [];
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("tasks")
      .select(TASK_ITEM_COLUMNS)
      .eq("organization_id", orgId)
      .eq("status", "open")
      .is("deleted_at", null)
      .is("owner_id", null)
      .in("team_id", teamIds)
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(OPEN_LIMIT),
    "team tasks",
  );
  return rows.map((row) => toTaskItem(row, new Map()));
}

export type CoveringGroup = { userId: string; name: string; kind: LeaveKind | null; endsOn: string; tasks: TaskItem[]; truncated: boolean };

/**
 * HEB-08: the open tasks of the colleagues the user stands in for today (the
 * business's date), one group per absent colleague, due first. The tasks stay in
 * the colleague's name; RLS lets the deputy read them only while the absence lasts.
 */
export async function listCoveringTasks(orgId: string, userId: string, orgTimeZone: string): Promise<CoveringGroup[]> {
  const absences = [...(await getCurrentAbsences(orgId, orgTimeZone)).values()].filter((a) => a.deputyId === userId && a.userId !== userId);
  if (absences.length === 0) return [];
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("tasks")
      .select(TASK_ITEM_COLUMNS)
      .eq("organization_id", orgId)
      .eq("status", "open")
      .is("deleted_at", null)
      .in("owner_id", absences.map((a) => a.userId))
      .order("due_at", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .limit(OPEN_LIMIT + 1),
    "covering tasks",
  );
  const shown = rows.slice(0, OPEN_LIMIT);
  const owners = await getUserNames(absences.map((a) => a.userId));
  return absences
    .map((a) => ({
      userId: a.userId,
      name: owners.get(a.userId) ?? "עמית",
      kind: a.kind,
      endsOn: a.endsOn,
      tasks: shown.filter((row) => row.owner_id === a.userId).map((row) => toTaskItem(row, owners)),
      truncated: rows.length > OPEN_LIMIT,
    }))
    .sort((x, y) => x.name.localeCompare(y.name, "he"));
}

export type TaskListItem = {
  id: string;
  title: string;
  taskType: string;
  // TASK-08: the business's type, and the name the table, its filter and the export show (taskTypeName)
  activityTypeId: string | null;
  typeName: string;
  status: TaskStatus;
  priority: number;
  dueAt: string | null;
  ownerId: string | null;
  ownerName: string | null;
  related: { kind: "lead" | "contact" | "company" | "deal"; id: string; name: string | null } | null;
  // TASK-06 part B: the parent task of a sub-task ("משימת אב"); title null when the user cannot see it
  parent: { id: string; title: string | null } | null;
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
    .select("id, title, task_type, activity_type_id, status, priority, due_at, owner_id, lead_id, contact_id, company_id, deal_id, parent_task_id, created_at")
    .eq("organization_id", orgId)
    .is("deleted_at", null);
  if (options.ownerId) {
    query = query.eq("owner_id", options.ownerId);
  }
  const searchFilter = textSearchFilter(options.search);
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

  const [owners, related, types, parents] = await Promise.all([
    getUserNames(rows.map((row) => row.owner_id)),
    relatedRecords(orgId, rows),
    listActivityTypes(orgId),
    taskTitles(orgId, rows.map((row) => row.parent_task_id)),
  ]);

  return {
    hasMore: data.length > size,
    tasks: rows.map((row) => {
      return {
        id: row.id,
        title: row.title,
        taskType: row.task_type,
        activityTypeId: row.activity_type_id,
        typeName: taskTypeName({ taskType: row.task_type, activityTypeId: row.activity_type_id }, types),
        status: row.status,
        priority: row.priority,
        dueAt: row.due_at,
        ownerId: row.owner_id,
        ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
        related: related(row),
        parent: row.parent_task_id ? { id: row.parent_task_id, title: parents.get(row.parent_task_id) ?? null } : null,
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

/** TASK-06 part B: the titles of tasks by id (parents of sub-tasks), read with the user's rights; a hidden one is missing. */
export async function taskTitles(orgId: string, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const supabase = await createClient();
  const rows = await readAllPagesByIds(unique, async (slice, from, to) =>
    must(await supabase.from("tasks").select("id, title").eq("organization_id", orgId).in("id", slice).order("id").range(from, to), "parent tasks"),
  );
  return new Map(rows.map((row) => [row.id, row.title]));
}

export type SubtaskItem = { id: string; parentId: string; title: string; status: TaskStatus; dueAt: string | null; ownerName: string | null };

/**
 * TASK-06 part B: the live sub-tasks of the given tasks that the user sees (RLS decides, so "N מתוך M" counts those),
 * per parent, in the order they were made.
 */
export async function listSubtasks(orgId: string, parentIds: string[]): Promise<Map<string, SubtaskItem[]>> {
  const byParent = new Map<string, SubtaskItem[]>();
  if (parentIds.length === 0) return byParent;
  const supabase = await createClient();
  const rows = await readAllPagesByIds([...new Set(parentIds)], async (slice, from, to) =>
    must(
      await supabase
        .from("tasks")
        .select("id, parent_task_id, title, status, due_at, owner_id, created_at")
        .eq("organization_id", orgId)
        .in("parent_task_id", slice)
        .is("deleted_at", null)
        .order("created_at")
        .order("id")
        .range(from, to),
      "sub-tasks",
    ),
  );
  const owners = await getUserNames(rows.map((row) => row.owner_id));
  for (const row of rows) {
    if (!row.parent_task_id || row.status === "cancelled") continue;
    const list = byParent.get(row.parent_task_id) ?? [];
    list.push({
      id: row.id,
      parentId: row.parent_task_id,
      title: row.title,
      status: row.status,
      dueAt: row.due_at,
      ownerName: row.owner_id ? (owners.get(row.owner_id) ?? null) : null,
    });
    byParent.set(row.parent_task_id, list);
  }
  return byParent;
}

import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { Pagination } from "@/components/ui/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SearchIcon, CheckSquareIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { inlineEditing } from "@/features/inline-edit/server";
import { resolveColumns } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { ExportMenu, exportHref } from "@/features/list-export/components/export-menu";
import { AdvancedFilter } from "@/features/list-filters/components/advanced-filter";
import { prepareListFilter } from "@/features/list-filters/prepare";
import { canExport } from "@/features/reports/request";
import { listMembers } from "@/features/settings/queries";
import { getOrgContext, type OrgContext } from "@/features/shell/queries";
import { NewTaskPanel } from "@/features/tasks/components/new-task-panel";
import { TaskForm } from "@/features/tasks/components/task-form";
import { remindOption } from "@/features/tasks/components/task-fields";
import { TaskRow, type TaskRowView } from "@/features/tasks/components/task-row";
import { TasksTable } from "@/features/tasks/components/tasks-table";
import { listTaskGroups, listTasks, TASK_DEFAULT_SORT, TASK_SORT_COLUMNS, type TaskItem } from "@/features/tasks/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { cn } from "@/lib/cn";
import { formatDateTime, formatNumber, zoneDate, zoneTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";
import { nextSort, parseSort, sortValue } from "@/lib/sort";

export const metadata: Metadata = { title: "משימות" };

type Query = Record<string, string | string[] | undefined>;
type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Query>;
};

const tabClass = (active: boolean) =>
  cn(
    "-mb-px flex min-h-11 items-center border-b-2 px-3 text-md whitespace-nowrap",
    active ? "border-accent font-semibold text-accent-strong" : "border-transparent text-ink-soft hover:text-ink",
  );

/** Whose tasks ("mine" or everything the user sees), and list or table: shown above both views. */
function TasksNav({ orgId, showAll, table }: { orgId: string; showAll: boolean; table: boolean }) {
  const href = (all: boolean, asTable: boolean) => {
    const params = new URLSearchParams();
    if (all) params.set("who", "all");
    if (asTable) params.set("view", "table");
    const qs = params.toString();
    return qs ? `${paths.tasks(orgId)}?${qs}` : paths.tasks(orgId);
  };
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-2 border-b border-line">
      <nav aria-label="של מי המשימות">
        <ul className="flex gap-1">
          <li>
            <Link href={href(false, table)} aria-current={showAll ? undefined : "page"} className={tabClass(!showAll)}>
              שלי
            </Link>
          </li>
          <li>
            <Link href={href(true, table)} aria-current={showAll ? "page" : undefined} className={tabClass(showAll)}>
              כל המשימות שאני רואה
            </Link>
          </li>
        </ul>
      </nav>
      <nav aria-label="תצוגה" className="mb-1.5 flex gap-1 rounded-md border border-line bg-surface p-1">
        {(
          [
            { key: "list", label: "רשימה", asTable: false },
            { key: "table", label: "טבלה", asTable: true },
          ] as const
        ).map((option) => (
          <Link
            key={option.key}
            href={href(showAll, option.asTable)}
            aria-current={option.asTable === table ? "page" : undefined}
            className={cn("rounded px-3 py-1.5 text-md", option.asTable === table ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink-soft hover:bg-canvas")}
          >
            {option.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

const RELATED_LABEL = { lead: "לליד", contact: "לאיש הקשר", company: "לחברה", deal: "לעסקה" } as const;

function relatedHref(orgId: string, related: NonNullable<TaskItem["related"]>): string {
  switch (related.kind) {
    case "lead":
      return paths.lead(orgId, related.id);
    case "contact":
      return paths.contact(orgId, related.id);
    case "company":
      return paths.company(orgId, related.id);
    case "deal":
      return paths.deal(orgId, related.id);
  }
}

export default async function TasksPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const { user, canWrite } = context;
  const query = await searchParams;
  const showAll = firstParam(query.who) === "all";
  if (firstParam(query.view) === "table") {
    return <TasksTableView orgId={orgId} context={context} query={query} showAll={showAll} />;
  }

  const [groups, members] = await Promise.all([listTaskGroups(orgId, showAll ? null : user.id), listMembers(orgId)]);
  const assignees = members
    .filter((member) => member.status === "active" && member.role !== "viewer")
    .map((member) => ({ userId: member.userId, name: member.userId === user.id ? `${member.name} (אני)` : member.name }));

  const view = (task: TaskItem, overdue: boolean): TaskRowView => {
    const due = task.dueAt ? new Date(task.dueAt) : null;
    return {
      id: task.id,
      title: task.title,
      done: task.completedAt !== null,
      overdue,
      dueText: task.dueAt ? formatDateTime(task.dueAt) : null,
      dueDate: due ? zoneDate(due) : null,
      dueTime: due ? zoneTime(due) : null,
      remind: remindOption(task.dueAt, task.remindAt),
      completedText: task.completedAt ? formatDateTime(task.completedAt) : null,
      ownerId: task.ownerId,
      ownerName: task.ownerName,
      taskType: task.taskType,
      priority: task.priority,
      outcome: task.outcome,
      recurrence: task.recurrence,
      related: task.related ? { href: relatedHref(orgId, task.related), label: RELATED_LABEL[task.related.kind] } : null,
    };
  };

  const sections: Array<{ key: string; title: string; tasks: TaskItem[]; overdue?: boolean }> = [
    { key: "overdue", title: "באיחור", tasks: groups.overdue, overdue: true },
    { key: "today", title: "היום", tasks: groups.today },
    { key: "upcoming", title: "בהמשך", tasks: groups.upcoming },
    { key: "undated", title: "בלי תאריך", tasks: groups.undated },
  ];
  const openCount = sections.reduce((sum, section) => sum + section.tasks.length, 0);

  return (
    <>
      <PageHeader title="משימות" description={`${formatNumber(openCount)} משימות פתוחות.`} />

      <TasksNav orgId={orgId} showAll={showAll} table={false} />

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-5">
          {groups.truncated ? (
            <p role="status" className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              מוצגות 300 המשימות הפתוחות הראשונות לפי תאריך יעד.
            </p>
          ) : null}
          {openCount === 0 ? (
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState icon={<CheckSquareIcon />} title="אין משימות פתוחות" description="משימה חדשה מוסיפים בכפתור &quot;משימה חדשה&quot;. אפשר להטיל משימה גם על חבר צוות." />
            </div>
          ) : (
            sections
              .filter((section) => section.tasks.length > 0)
              .map((section) => (
                <Card key={section.key} aria-labelledby={`tasks-${section.key}`}>
                  <CardHeader id={`tasks-${section.key}`} title={`${section.title} (${formatNumber(section.tasks.length)})`} />
                  <ul className="divide-y divide-line">
                    {section.tasks.map((task) => (
                      <TaskRow
                        key={`${task.id}-${task.dueAt}-${task.remindAt}-${task.ownerId}`}
                        orgId={orgId}
                        task={view(task, section.overdue === true)}
                        canEdit={canWrite}
                        showOwner={showAll}
                        assignees={assignees}
                      />
                    ))}
                  </ul>
                </Card>
              ))
          )}

          {groups.done.length > 0 ? (
            <Card aria-labelledby="tasks-done">
              <CardHeader id="tasks-done" title="הושלמו לאחרונה" />
              <ul className="divide-y divide-line">
                {groups.done.map((task) => (
                  <TaskRow
                    key={task.id}
                    orgId={orgId}
                    task={view(task, false)}
                    canEdit={canWrite}
                    showOwner={showAll}
                    assignees={assignees}
                  />
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        {canWrite ? (
          // first on a phone, beside the list on a computer
          <div className="order-first lg:sticky lg:top-20 lg:order-none">
            <NewTaskPanel>
              <Card aria-labelledby="new-task-title">
                <CardHeader id="new-task-title" title="משימה חדשה" />
                <CardBody>
                  <TaskForm orgId={orgId} assignees={assignees} myUserId={user.id} today={zoneDate(new Date(), context.org.timeZone)} />
                </CardBody>
              </Card>
            </NewTaskPanel>
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * The table view (LST-09): every task (open and closed), with search, advanced
 * filter, sorting, the user's columns, saved views, editing in the cell, bulk
 * actions and export, as in the other lists.
 */
async function TasksTableView({ orgId, context, query, showAll }: { orgId: string; context: OrgContext; query: Query; showAll: boolean }) {
  const search = firstParam(query.q).trim();
  const page = parsePage(query.page);
  const listColumns = await getListColumns(orgId, "task");
  const filter = await prepareListFilter(orgId, "task", firstParam(query.f), context.user.id, []);
  const filterParam = filter.tree ? JSON.stringify(filter.tree) : null;
  const sortKeys = Object.keys(TASK_SORT_COLUMNS) as Array<keyof typeof TASK_SORT_COLUMNS>;
  const sort = parseSort(firstParam(query.sort), sortKeys, TASK_DEFAULT_SORT);

  const [editing, viewData, { tasks, hasMore }] = await Promise.all([
    inlineEditing(orgId, context),
    viewChips(orgId, "task", context),
    listTasks(orgId, { ownerId: showAll ? null : context.user.id, search, page, sort, filter: filter.logic }),
  ]);
  const views = viewData.chips;
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("task", activeView.config.columns, listColumns.catalog) : listColumns.columns;

  const listHref = (target: number, sortParam: string) => {
    const next = new URLSearchParams();
    next.set("view", "table");
    if (showAll) next.set("who", "all");
    if (search) next.set("q", search);
    if (sortParam !== sortValue(TASK_DEFAULT_SORT)) next.set("sort", sortParam);
    if (filterParam) next.set("f", filterParam);
    if (activeView) next.set("sv", activeView.id);
    if (target > 1) next.set("page", String(target));
    return `${paths.tasks(orgId)}?${next.toString()}`;
  };
  const hrefFor = (target: number) => listHref(target, sortValue(sort));
  const sortHref = (key: string) => listHref(1, sortValue(nextSort(sort, key as (typeof sortKeys)[number], key !== "created")));
  const isFiltered = search !== "" || filter.tree !== null;
  // the time of this request, to mark open tasks that are past due
  const now = new Date().getTime();

  return (
    <>
      <PageHeader title="משימות" />
      <TasksNav orgId={orgId} showAll={showAll} table />
      <SavedViewsBar
        orgId={orgId}
        objectType="task"
        listPath={paths.tasks(orgId)}
        views={views}
        activeViewId={activeView?.id ?? null}
        current={{ view: "table", who: showAll ? "all" : undefined, q: search || undefined, f: filterParam ?? undefined }}
        currentSort={sortValue(sort)}
        currentColumns={shownColumns}
        teams={viewData.teams}
        canSave={context.role !== "viewer"}
        canShare={context.role === "owner" || context.role === "admin"}
      />
      <div className="mb-3 flex flex-wrap items-start justify-end gap-2">
        {canExport(context.role) ? <ExportMenu href={exportHref(paths.tasks(orgId), listHref(1, sortValue(sort)))} /> : null}
        <AdvancedFilter
          fields={filter.fields}
          current={filter.tree}
          skipped={filter.skipped}
          listPath={paths.tasks(orgId)}
          keep={Object.fromEntries(Object.entries({ view: "table", who: showAll ? "all" : "", q: search }).filter(([, v]) => v))}
        />
        {activeView?.config.columns ? (
          <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
        ) : (
          <ColumnsPanel orgId={orgId} object="task" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
        )}
      </div>

      <Form action={paths.tasks(orgId)} role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="view" value="table" />
        {showAll ? <input type="hidden" name="who" value="all" /> : null}
        <TextField label="חיפוש משימות" hideLabel name="q" type="search" placeholder="חיפוש לפי כותרת" defaultValue={search} className="min-w-0 flex-[1_1_14rem]" />
        <button type="submit" className={buttonClasses("secondary")}>
          <SearchIcon className="size-4.5" />
          חיפוש
        </button>
      </Form>

      {tasks.length > 0 ? (
        <TasksTable
          orgId={orgId}
          tasks={tasks}
          columns={shownColumns}
          catalog={listColumns.catalog}
          sort={sort}
          sortHref={sortHref}
          editing={editing}
          now={now}
        />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {isFiltered || page > 1 ? (
            <EmptyState kind="search"
              title="לא נמצאו משימות"
              description="אין משימות שמתאימות לחיפוש או לסינון. נסו מילה אחרת או נקו את הסינון."
              action={
                <ButtonLink href={`${paths.tasks(orgId)}?view=table${showAll ? "&who=all" : ""}`} variant="secondary">
                  ניקוי הסינון
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState icon={<CheckSquareIcon />} title="אין משימות" description="משימה חדשה מוסיפים בתצוגת הרשימה, או בכרטיס של ליד, איש קשר או עסקה." />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}

import Link from "next/link";

import { Badge, type BadgeTone } from "@/components/ui/badge";
import { BulkSelection, RowCheck } from "@/features/bulk/components/bulk-selection";
import { InlineEdit } from "@/features/inline-edit/components/inline-edit";
import type { InlineEditing } from "@/features/inline-edit/server";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { TaskStatus } from "@/lib/database.types";
import { formatDate, formatDateTime } from "@/lib/format";
import { paths } from "@/lib/paths";
import type { Sort } from "@/lib/sort";

import type { TaskListItem } from "../queries";
import { PRIORITY_LABEL, TASK_TYPE_OPTIONS } from "./task-fields";

type Props = {
  orgId: string;
  tasks: TaskListItem[];
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  sort: Sort<string>;
  sortHref: (key: string) => string;
  editing: InlineEditing;
  // now, to mark open tasks that are past due
  now: number;
};

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: BadgeTone }> = {
  open: { label: "פתוחה", tone: "accent" },
  done: { label: "הושלמה", tone: "success" },
  cancelled: { label: "בוטלה", tone: "neutral" },
};
const TYPE_LABEL = new Map<string, string>(TASK_TYPE_OPTIONS.map((o) => [o.value, o.label]));

const relatedHref = (orgId: string, related: NonNullable<TaskListItem["related"]>) =>
  related.kind === "lead"
    ? paths.lead(orgId, related.id)
    : related.kind === "contact"
      ? paths.contact(orgId, related.id)
      : related.kind === "company"
        ? paths.company(orgId, related.id)
        : paths.deal(orgId, related.id);

/** Tasks as a table (LST-09): sorting, the user's columns, editing in the cell and bulk actions, as in the other lists. */
export function TasksTable({ orgId, tasks, columns, catalog, sort, sortHref, editing, now }: Props) {
  return (
    <BulkSelection
      orgId={orgId}
      object="task"
      ids={tasks.map((row) => row.id)}
      owners={editing.bulk?.reassign ? editing.owners : null}
      statuses={(Object.keys(TASK_STATUS) as TaskStatus[]).map((status) => ({ value: status, label: TASK_STATUS[status].label }))}
      tags={[]}
      canTrash={false}
      exportPath={editing.bulk?.exportable ? `${paths.tasks(orgId)}/export` : null}
      enabled={editing.bulk !== null}
    >
      <ListTable
        label="טבלת משימות"
        nameColumn={{ key: "title", label: "כותרת" }}
        rows={tasks}
        rowKey={(task) => task.id}
        columns={columns}
        catalog={catalog}
        fields={[]}
        sort={sort}
        sortHref={sortHref}
        customValues={() => ({})}
        nameCell={(task) => (
          <div className="flex items-start gap-2">
            <RowCheck id={task.id} label={task.title} />
            <div className="min-w-0">
              <InlineEdit
                orgId={orgId}
                object="task"
                id={task.id}
                field="name"
                kind="text"
                label={`כותרת: ${task.title}`}
                initial={{ text: task.title }}
                canEdit={editing.canEdit(task.ownerId)}
              >
                <span className={task.status === "open" ? "font-medium" : "text-ink-soft line-through"}>{task.title}</span>
              </InlineEdit>
            </div>
          </div>
        )}
        cell={(key, task) => {
          switch (key) {
            case "due": {
              if (!task.dueAt) return null;
              const late = task.status === "open" && Date.parse(task.dueAt) < now;
              return (
                <time dateTime={task.dueAt} className={late ? "font-medium whitespace-nowrap text-danger" : "whitespace-nowrap"}>
                  {formatDateTime(task.dueAt)}
                  {late ? <span className="sr-only"> (באיחור)</span> : null}
                </time>
              );
            }
            case "type":
              return TYPE_LABEL.get(task.taskType) ?? task.taskType;
            case "status":
              return <Badge tone={TASK_STATUS[task.status].tone}>{TASK_STATUS[task.status].label}</Badge>;
            case "priority":
              return PRIORITY_LABEL[task.priority] ?? null;
            case "related":
              return task.related ? (
                <Link href={relatedHref(orgId, task.related)} className="underline-offset-4 hover:underline">
                  {task.related.name ?? "פתיחה"}
                </Link>
              ) : null;
            case "owner":
              return (
                <InlineEdit
                  orgId={orgId}
                  object="task"
                  id={task.id}
                  field="owner"
                  kind="select"
                  label={`אחראי: ${task.title}`}
                  initial={{ id: task.ownerId }}
                  options={editing.owners}
                  emptyOption="ללא אחראי"
                  canEdit={editing.canReassign(task.ownerId)}
                >
                  {task.ownerName}
                </InlineEdit>
              );
            case "created":
              return (
                <time dateTime={task.createdAt} className="whitespace-nowrap text-ink-soft">
                  {formatDate(task.createdAt)}
                </time>
              );
            default:
              return null;
          }
        }}
      />
    </BulkSelection>
  );
}

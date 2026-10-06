"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { cn } from "@/lib/cn";

import { completeTaskAction, reopenTaskAction, updateTaskAction } from "../actions";
import { TASK_TYPE_OPTIONS, TaskFields, type AssigneeOption } from "./task-fields";

export type TaskRowView = {
  id: string;
  title: string;
  done: boolean;
  overdue: boolean;
  // formatted on the server so server and browser output cannot differ
  dueText: string | null;
  dueDate: string | null;
  dueTime: string | null;
  completedText: string | null;
  ownerId: string | null;
  ownerName: string | null;
  taskType: string;
  related: { href: string; label: string } | null;
};

type Props = { orgId: string; task: TaskRowView; canEdit: boolean; showOwner: boolean; assignees: AssigneeOption[] };

export function TaskRow({ orgId, task, canEdit, showOwner, assignees }: Props) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await (task.done ? reopenTaskAction : completeTaskAction)(orgId, task.id);
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  if (editing) {
    return (
      <li className="px-4 py-3.5 sm:px-5">
        <TaskEditForm orgId={orgId} task={task} assignees={assignees} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className={cn("break-words font-medium", task.done && "text-ink-soft line-through")}>{task.title}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-ink-soft">
          {task.done && task.completedText ? <span>הושלמה {task.completedText}</span> : null}
          {!task.done && task.dueText ? <span className={task.overdue ? "font-medium text-danger" : undefined}>{task.dueText}</span> : null}
          {task.taskType !== "todo" ? <span>{TASK_TYPE_OPTIONS.find((o) => o.value === task.taskType)?.label}</span> : null}
          {showOwner && task.ownerName ? <span>באחריות {task.ownerName}</span> : null}
          {task.related ? (
            <Link href={task.related.href} className="underline underline-offset-4 hover:text-ink">
              {task.related.label}
            </Link>
          ) : null}
        </p>
        {error ? (
          <p role="alert" className="mt-1 text-sm text-danger">
            {error}
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex shrink-0 gap-2">
          {task.done ? null : (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              עריכה
              <span className="sr-only">: {task.title}</span>
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={toggle} disabled={pending} aria-busy={pending || undefined}>
            {pending ? "מעדכן…" : task.done ? "החזרה לפתוחות" : "בוצע"}
            <span className="sr-only">: {task.title}</span>
          </Button>
        </div>
      ) : null}
    </li>
  );
}

type EditProps = { orgId: string; task: TaskRowView; assignees: AssigneeOption[]; onDone: () => void };

function TaskEditForm({ orgId, task, assignees, onDone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateTaskAction(orgId, task.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  // the current assignee stays selectable even if they are no longer active
  const options =
    task.ownerId && !assignees.some((a) => a.userId === task.ownerId)
      ? [{ userId: task.ownerId, name: task.ownerName ?? "משתמש" }, ...assignees]
      : assignees;

  return (
    <form action={formAction} className="space-y-4" noValidate aria-label={`עריכת המשימה ${task.title}`}>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TaskFields
        values={failure?.values ?? { title: task.title, due_date: task.dueDate, due_time: task.dueTime, owner_id: task.ownerId, task_type: task.taskType }}
        errors={failure?.fieldErrors ?? {}}
        assignees={options}
        defaultOwnerId={task.ownerId ?? ""}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton size="sm">שמירה</SubmitButton>
        <Button variant="ghost" size="sm" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

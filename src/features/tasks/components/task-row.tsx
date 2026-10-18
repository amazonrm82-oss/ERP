"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { cn } from "@/lib/cn";

import { inlineEditAction } from "@/features/inline-edit/actions";
import { TaskChecklist, type ChecklistTemplateOption } from "@/features/task-checklists/components/task-checklist";
import type { ChecklistStep } from "@/features/task-checklists/templates";
import { isRestDay } from "@/features/calendar-days/holidays";
import { addDays } from "@/lib/calendar-grid";

import { describeRecurrence, repeatValues, type Recurrence } from "../recurrence";
import { completeTaskAction, reopenTaskAction, setTaskOutcomeAction, snoozeTaskAction, updateTaskAction, type SnoozeWhen } from "../actions";
import type { BusinessDaysContext } from "./business-days-picker";
import { REMIND_OPTIONS, TASK_TYPE_OPTIONS, TaskFields, type AssigneeOption } from "./task-fields";

export type TaskRowView = {
  id: string;
  title: string;
  done: boolean;
  overdue: boolean;
  // formatted on the server so server and browser output cannot differ
  dueText: string | null;
  dueDate: string | null;
  dueTime: string | null;
  // REMIND_OPTIONS value
  remind: string;
  completedText: string | null;
  ownerId: string | null;
  ownerName: string | null;
  taskType: string;
  // 1 high, 2 normal, 3 low (TASK-01)
  priority: number;
  outcome: string | null;
  // TASK-04: how it repeats; null = once
  recurrence: Recurrence | null;
  related: { href: string; label: string } | null;
  // TASK-06: the steps inside the task, in order
  checklist?: ChecklistStep[];
};

type Props = {
  orgId: string;
  task: TaskRowView;
  canEdit: boolean;
  showOwner: boolean;
  assignees: AssigneeOption[];
  /** HEB-03: the "in N business days" choice in the edit form */
  businessDays?: BusinessDaysContext;
  /** TASK-06: the business's checklist templates, for "steps from a template" */
  templates?: ChecklistTemplateOption[];
};

export function TaskRow({ orgId, task, canEdit, showOwner, assignees, businessDays, templates = [] }: Props) {
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // HEB-02: the server says when a snooze moved past a rest day
  const [notice, setNotice] = useState<string | null>(null);

  // TASK-05: put off in one tap, or hand over to someone else, without opening the form
  function run(action: () => Promise<{ ok: boolean; message?: string }>) {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.message ?? null);
      else setNotice(result.message ?? null);
    });
  }
  const snooze = (when: SnoozeWhen) => run(() => snoozeTaskAction(orgId, task.id, when));
  // HEB-02: the server moves "tomorrow" past the business's rest days; say so on the button
  const tomorrowOff = businessDays ? isRestDay(addDays(businessDays.today, 1), businessDays.calendar) : false;
  const reassign = (ownerId: string) => run(() => inlineEditAction(orgId, "task", task.id, "owner", { id: ownerId }));
  const owners =
    task.ownerId && !assignees.some((a) => a.userId === task.ownerId) ? [{ userId: task.ownerId, name: task.ownerName ?? "משתמש" }, ...assignees] : assignees;

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
        <TaskEditForm orgId={orgId} task={task} assignees={assignees} businessDays={businessDays} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className={cn("break-words font-medium", task.done && "text-ink-soft line-through")}>
          {!task.done && task.priority === 1 ? (
            <Badge tone="danger" className="me-1.5 align-middle">
              עדיפות גבוהה
            </Badge>
          ) : null}
          {!task.done && task.recurrence ? (
            <Badge tone="accent" className="me-1.5 align-middle">
              חוזרת
            </Badge>
          ) : null}
          {task.title}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-ink-soft">
          {task.done && task.completedText ? <span>הושלמה {task.completedText}</span> : null}
          {!task.done && task.dueText ? <span className={task.overdue ? "font-medium text-danger" : undefined}>{task.dueText}</span> : null}
          {!task.done && task.recurrence ? <span>{describeRecurrence(task.recurrence)}</span> : null}
          {!task.done && task.remind !== "" ? <span>תזכורת {REMIND_OPTIONS.find((o) => o.value === task.remind)?.label}</span> : null}
          {task.taskType !== "todo" ? <span>{TASK_TYPE_OPTIONS.find((o) => o.value === task.taskType)?.label}</span> : null}
          {!task.done && task.priority === 3 ? <span>עדיפות נמוכה</span> : null}
          {showOwner && task.ownerName ? <span>באחריות {task.ownerName}</span> : null}
          {task.related ? (
            <Link href={task.related.href} className="underline underline-offset-4 hover:text-ink">
              {task.related.label}
            </Link>
          ) : null}
        </p>
        <TaskChecklist orgId={orgId} taskId={task.id} taskTitle={task.title} steps={task.checklist ?? []} canEdit={canEdit} templates={templates} />
        {task.done && canEdit ? <TaskOutcome orgId={orgId} task={task} /> : task.done && task.outcome ? <p className="mt-1 text-sm">תוצאה: {task.outcome}</p> : null}
        {error ? (
          <p role="alert" className="mt-1 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <p role="status" className="mt-1 text-sm text-ink-soft empty:hidden">
          {notice}
        </p>
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
            {pending ? "מעדכנים…" : task.done ? "החזרה לפתוחות" : "בוצע"}
            <span className="sr-only">: {task.title}</span>
          </Button>
        </div>
      ) : null}
      {canEdit && !task.done ? (
        <div className="flex w-full flex-wrap items-center gap-2" role="group" aria-label={`פעולות מהירות: ${task.title}`}>
          <span className="text-sm text-ink-soft">דחייה:</span>
          <Button variant="ghost" size="sm" onClick={() => snooze("tomorrow")} disabled={pending}>
            {tomorrowOff ? "ליום העבודה הבא" : "למחר"}
            <span className="sr-only">: {task.title}</span>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => snooze("week")} disabled={pending}>
            לעוד שבוע
            <span className="sr-only">: {task.title}</span>
          </Button>
          {showOwner && owners.length > 1 ? (
            <Select
              controlSize="sm"
              aria-label={`אחראי: ${task.title}`}
              className="ms-auto w-auto max-w-48"
              value={task.ownerId ?? ""}
              disabled={pending}
              onChange={(event) => reassign(event.target.value)}
            >
              {task.ownerId ? null : <option value="">ללא אחראי</option>}
              {owners.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

type EditProps = { orgId: string; task: TaskRowView; assignees: AssigneeOption[]; businessDays?: BusinessDaysContext; onDone: () => void };

function TaskEditForm({ orgId, task, assignees, businessDays, onDone }: EditProps) {
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
        values={
          failure?.values ?? {
            title: task.title,
            due_date: task.dueDate,
            due_time: task.dueTime,
            owner_id: task.ownerId,
            task_type: task.taskType,
            remind: task.remind,
            priority: String(task.priority),
            ...repeatValues(task.recurrence),
          }
        }
        errors={failure?.fieldErrors ?? {}}
        assignees={options}
        defaultOwnerId={task.ownerId ?? ""}
        businessDays={businessDays}
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

/** What came of a completed task (TASK-03): shown in a line, written in place. */
function TaskOutcome({ orgId, task }: { orgId: string; task: TaskRowView }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.outcome ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (!editing) {
    return (
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm">
        {task.outcome ? <span>תוצאה: {task.outcome}</span> : null}
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          {task.outcome ? "שינוי התוצאה" : "הוספת תוצאה"}
          <span className="sr-only">: {task.title}</span>
        </Button>
      </p>
    );
  }
  return (
    <form
      className="mt-2 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        setError(null);
        startTransition(async () => {
          const result = await setTaskOutcomeAction(orgId, task.id, text);
          if (result.ok) setEditing(false);
          else setError(result.message);
        });
      }}
    >
      <Input
        aria-label={`תוצאה: ${task.title}`}
        controlSize="sm"
        className="min-w-0 flex-1"
        value={text}
        maxLength={500}
        placeholder="למשל: נשלחה הצעה, מחכים לתשובה"
        onChange={(event) => setText(event.target.value)}
        autoFocus
      />
      <Button type="submit" size="sm" loading={pending}>
        שמירת התוצאה
      </Button>
      <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
        ביטול
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

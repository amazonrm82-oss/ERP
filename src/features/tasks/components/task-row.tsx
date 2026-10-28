"use client";

import Link from "next/link";
import { useActionState, useRef, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { SearchPicker } from "@/components/ui/search-picker";
import { Input, Select } from "@/components/ui/field";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { cn } from "@/lib/cn";

import { inlineEditAction } from "@/features/inline-edit/actions";
import { TaskChecklist, type ChecklistTemplateOption } from "@/features/task-checklists/components/task-checklist";
import type { ChecklistStep } from "@/features/task-checklists/templates";
import { isRestDay } from "@/features/calendar-days/holidays";
import type { ActivityTypeOption } from "@/features/activity-types/types";
import { addDays } from "@/lib/calendar-grid";
import { CollectionWhatsapp } from "@/features/collection/components/collection-whatsapp";
import type { WhatsappListContext } from "@/features/whatsapp/templates";

import { describeRecurrence, repeatValues, type Recurrence } from "../recurrence";
import { searchParentTasksAction } from "../picker-actions";
import { openSubtasksQuestion, subtaskProgress, type SubtaskView } from "../subtasks";
import { Subtasks } from "./subtasks";
import { completeTaskAction, reopenTaskAction, setTaskOutcomeAction, snoozeTaskAction, takeTaskAction, updateTaskAction, type SnoozeWhen } from "../actions";
import type { BusinessDaysContext } from "./business-days-picker";
import { REMIND_OPTIONS, TaskFields, type AssigneeOption } from "./task-fields";

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
  // TASK-08: the name the row shows for the task's kind (null for a plain "משימה"), and the edit form's choice
  kindLabel: string | null;
  kindChoice: string;
  // 1 high, 2 normal, 3 low (TASK-01)
  priority: number;
  outcome: string | null;
  // TASK-04: how it repeats; null = once
  recurrence: Recurrence | null;
  related: { href: string; label: string } | null;
  // TASK-06: the steps inside the task, in order
  checklist?: ChecklistStep[];
  // TASK-07: an open task of a team that nobody took yet; the first to press "לקחתי" owns it
  // canTake: the user may take it (the rule of public.take_task); others see it without the button
  teamTask?: { teamName: string; canTake: boolean } | null;
  // TASK-06 part B: a top-level task's sub-tasks (the ones the user sees)
  subtasks?: SubtaskView[];
  // TASK-06 part B: set on a sub-task (null on any other task); title null when the user cannot see the parent.
  // Required, so every screen that shows the row (and its edit form, which hides the repeat for a sub-task) says it.
  parent: { id: string; title: string | null } | null;
  // COL-04: a collection reminder task (made by the server) names its document; the row offers a WhatsApp reminder
  collectionDocumentId?: string | null;
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
  /** TASK-08: the business's activity and task types, for the edit form */
  kinds?: ActivityTypeOption[];
  /** COL-04: the user's and business's names for the collection reminder's WhatsApp text; null for someone who cannot write */
  whatsapp?: WhatsappListContext | null;
};

export function TaskRow({ orgId, task, canEdit, showOwner, assignees, businessDays, templates = [], kinds = [], whatsapp = null }: Props) {
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
  // TASK-06 part B: completing a parent with open sub-tasks asks first, and never blocks
  const openSubtasks = task.parent ? 0 : (subtaskProgress(task.subtasks ?? [])?.open ?? 0);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await (task.done ? reopenTaskAction : completeTaskAction)(orgId, task.id);
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  if (task.teamTask && !task.done) {
    return <TeamTaskRow orgId={orgId} task={task} teamName={task.teamTask.teamName} canTake={canEdit && task.teamTask.canTake} />;
  }

  if (editing) {
    return (
      <li className="px-4 py-3.5 sm:px-5">
        <TaskEditForm orgId={orgId} task={task} assignees={assignees} businessDays={businessDays} kinds={kinds} onDone={() => setEditing(false)} />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        {task.parent ? (
          <p className="text-sm text-ink-soft">{task.parent.title ? `תת-משימה של: ${task.parent.title}` : "תת-משימה"}</p>
        ) : null}
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
          {task.kindLabel ? <span>{task.kindLabel}</span> : null}
          {!task.done && task.priority === 3 ? <span>עדיפות נמוכה</span> : null}
          {showOwner && task.ownerName ? <span>באחריות {task.ownerName}</span> : null}
          {task.related ? (
            <Link href={task.related.href} className="underline underline-offset-4 hover:text-ink">
              {task.related.label}
            </Link>
          ) : null}
        </p>
        {task.collectionDocumentId && whatsapp && canEdit && !task.done ? (
          <div className="mt-2">
            <CollectionWhatsapp orgId={orgId} taskId={task.id} context={whatsapp} />
          </div>
        ) : null}
        <TaskChecklist orgId={orgId} taskId={task.id} taskTitle={task.title} steps={task.checklist ?? []} canEdit={canEdit} templates={templates} />
        {task.parent ? null : <Subtasks orgId={orgId} taskId={task.id} taskTitle={task.title} subtasks={task.subtasks ?? []} canEdit={canEdit} assignees={assignees} />}
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
          {!task.done && openSubtasks > 0 ? (
            <ConfirmButton
              variant="secondary"
              title={openSubtasksQuestion(openSubtasks)}
              description="תתי-המשימות הפתוחות יישארו פתוחות."
              confirmLabel="לסיים בכל זאת"
              action={() => completeTaskAction(orgId, task.id)}
              disabled={pending}
            >
              בוצע
              <span className="sr-only">: {task.title}</span>
            </ConfirmButton>
          ) : (
            <Button variant="secondary" size="sm" onClick={toggle} disabled={pending} aria-busy={pending || undefined}>
              {pending ? "מעדכנים…" : task.done ? "החזרה לפתוחות" : "בוצע"}
              <span className="sr-only">: {task.title}</span>
            </Button>
          )}
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

/** TASK-07: a team task nobody took yet. Seen by the whole team; "לקחתי" makes the user its owner, first one wins. */
function TeamTaskRow({ orgId, task, teamName, canTake }: { orgId: string; task: TaskRowView; teamName: string; canTake: boolean }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function take() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await takeTaskAction(orgId, task.id);
      if (result.ok) setNotice(result.message ?? null);
      else setError(result.message);
    });
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">
          <Badge tone="accent" className="me-1.5 align-middle">
            לצוות {teamName}
          </Badge>
          {!task.done && task.priority === 1 ? (
            <Badge tone="danger" className="me-1.5 align-middle">
              עדיפות גבוהה
            </Badge>
          ) : null}
          {task.title}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-sm text-ink-soft">
          {task.dueText ? <span className={task.overdue ? "font-medium text-danger" : undefined}>{task.dueText}</span> : null}
          {task.kindLabel ? <span>{task.kindLabel}</span> : null}
          <span>עדיין אין אחראי. מי שלוקח ראשון הופך לאחראי.</span>
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
        <p role="status" className="mt-1 text-sm text-ink-soft empty:hidden">
          {notice}
        </p>
      </div>
      {canTake ? (
        <Button variant="secondary" size="sm" onClick={take} disabled={pending} aria-busy={pending || undefined}>
          {pending ? "לוקחים…" : "לקחתי"}
          <span className="sr-only">: {task.title}</span>
        </Button>
      ) : null}
    </li>
  );
}

type EditProps = {
  orgId: string;
  task: TaskRowView;
  assignees: AssigneeOption[];
  businessDays?: BusinessDaysContext;
  kinds: ActivityTypeOption[];
  onDone: () => void;
};

function TaskEditForm({ orgId, task, assignees, businessDays, kinds, onDone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateTaskAction(orgId, task.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  // TASK-06 part B (owner, answer (3) ב): linking to a parent of another record asks first; the server sends the question
  const formRef = useRef<HTMLFormElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const moveQuestion = failure?.fieldErrors?.confirm_move ?? null;
  // the answer whose question was closed (by "ביטול" or by confirming); a new answer asks again
  const [answered, setAnswered] = useState<FormState>(null);
  const asking = moveQuestion && answered !== state ? moveQuestion : null;
  const errors = failure?.fieldErrors ? Object.fromEntries(Object.entries(failure.fieldErrors).filter(([key]) => key !== "confirm_move")) : {};
  // a task with sub-tasks cannot become one (one level); a sub-task shows its parent and may be detached
  const canPickParent = (task.subtasks ?? []).length === 0;
  const parentInitial =
    failure?.values && "parent_task_id" in failure.values
      ? failure.values.parent_task_id
        ? { id: failure.values.parent_task_id, label: failure.values.parent_task_id__label || "משימה" }
        : null
      : task.parent
        ? { id: task.parent.id, label: task.parent.title ?? "משימה" }
        : null;
  // the current assignee stays selectable even if they are no longer active
  const options =
    task.ownerId && !assignees.some((a) => a.userId === task.ownerId)
      ? [{ userId: task.ownerId, name: task.ownerName ?? "משתמש" }, ...assignees]
      : assignees;

  return (
    <form ref={formRef} action={formAction} className="space-y-4" noValidate aria-label={`עריכת המשימה ${task.title}`}>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <input ref={confirmRef} type="hidden" name="confirm_move" defaultValue="" />
      <TaskFields
        values={
          failure?.values ?? {
            title: task.title,
            due_date: task.dueDate,
            due_time: task.dueTime,
            owner_id: task.ownerId,
            task_type: task.kindChoice,
            remind: task.remind,
            priority: String(task.priority),
            ...repeatValues(task.recurrence),
          }
        }
        errors={errors}
        assignees={options}
        defaultOwnerId={task.ownerId ?? ""}
        businessDays={businessDays}
        kinds={kinds}
        // TASK-06 part B: a sub-task does not repeat
        repeat={!task.parent}
      />
      {canPickParent ? (
        <SearchPicker
          label="משימת אב"
          name="parent_task_id"
          initial={parentInitial}
          search={(query) => searchParentTasksAction(orgId, task.id, query)}
          placeholder="הקלידו את כותרת המשימה"
          hint="תת-משימה עוברת לרשומה של משימת האב. הסרה מנתקת אותה ומשאירה את הרשומה שלה."
          error={errors.parent_task_id}
          onChange={() => {
            // a new pick is asked about again
            if (confirmRef.current) confirmRef.current.value = "";
          }}
        />
      ) : (
        <p className="text-sm text-ink-soft">למשימה הזו יש תתי-משימות, ולכן היא לא יכולה להיות תת-משימה.</p>
      )}
      <Dialog
        open={asking !== null}
        onClose={() => setAnswered(state)}
        title="קישור למשימת אב"
        description={asking ?? undefined}
        footer={
          <>
            <Button variant="secondary" autoFocus onClick={() => setAnswered(state)}>
              ביטול
            </Button>
            <Button
              onClick={() => {
                setAnswered(state);
                if (confirmRef.current) confirmRef.current.value = "1";
                formRef.current?.requestSubmit();
              }}
            >
              לקשר ולהעביר
            </Button>
          </>
        }
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

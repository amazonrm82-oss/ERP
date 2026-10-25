"use client";

import { useId, useOptimistic, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-picker";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";

import { addSubtaskAction, completeTaskAction, reopenTaskAction } from "../actions";
import { subtaskProgress, SUBTASK_TITLE_MAX, type SubtaskView } from "../subtasks";
import type { AssigneeOption } from "./task-fields";

type Props = {
  orgId: string;
  taskId: string;
  taskTitle: string;
  subtasks: SubtaskView[];
  canEdit: boolean;
  assignees: AssigneeOption[];
};

/**
 * TASK-06 part B: the sub-tasks of a task, under it. A line "תתי-משימות: הושלמו N מתוך M" opens the list; each sub-task is
 * ticked in place (it is an ordinary task, also in the lists and My day), and a new one is added with a title, an optional
 * date and an optional assignee.
 */
export function Subtasks({ orgId, taskId, taskTitle, subtasks, canEdit, assignees }: Props) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(subtasks, (current: SubtaskView[], change: { id: string; done: boolean }) =>
    current.map((s) => (s.id === change.id ? { ...s, done: change.done } : s)),
  );
  const progress = subtaskProgress(shown);

  if (!progress && !canEdit) return null;

  const toggle = (subtask: SubtaskView, done: boolean) => {
    setError(null);
    startTransition(async () => {
      setShown({ id: subtask.id, done });
      const result = await (done ? completeTaskAction : reopenTaskAction)(orgId, subtask.id);
      if (!result.ok) setError(result.message);
    });
  };

  const add = () => {
    if (!title.trim()) return;
    setError(null);
    startTransition(async () => {
      const result = await addSubtaskAction(orgId, taskId, { title, dueDate: dueDate || null, ownerId: ownerId || null });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setTitle("");
      setDueDate("");
      setOwnerId("");
    });
  };

  return (
    <div className="mt-1">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(progress && progress.open === 0 && "text-success")}
      >
        {progress ? `תתי-משימות: ${progress.text}` : "הוספת תת-משימה"}
        <span className="sr-only">: {taskTitle}</span>
      </Button>
      {open ? (
        <div id={panelId} className="mt-2 space-y-3 rounded-md border border-line bg-canvas p-3">
          {shown.length > 0 ? (
            <ul className="space-y-1.5" aria-label={`תתי-המשימות של ${taskTitle}`}>
              {shown.map((subtask) => (
                <li key={subtask.id}>
                  <label className="flex min-w-0 items-start gap-2 text-md">
                    <input
                      type="checkbox"
                      checked={subtask.done}
                      disabled={!canEdit || pending}
                      onChange={(event) => toggle(subtask, event.target.checked)}
                      className="mt-1 size-4 shrink-0 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className={cn("break-words", subtask.done && "text-ink-soft line-through")}>{subtask.title}</span>
                      {subtask.dueText || subtask.ownerName ? (
                        <span className="flex flex-wrap gap-x-3 text-sm text-ink-soft">
                          {subtask.dueText && !subtask.done ? <span className={subtask.overdue ? "font-medium text-danger" : undefined}>{subtask.dueText}</span> : null}
                          {subtask.ownerName ? <span>באחריות {subtask.ownerName}</span> : null}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-soft">אין עדיין תתי-משימות.</p>
          )}
          {canEdit ? (
            <form
              className="flex flex-wrap items-end gap-2"
              aria-label={`תת-משימה חדשה: ${taskTitle}`}
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <Input
                aria-label={`כותרת תת-המשימה: ${taskTitle}`}
                controlSize="sm"
                className="min-w-0 flex-[1_1_12rem]"
                value={title}
                maxLength={SUBTASK_TITLE_MAX}
                placeholder="תת-משימה חדשה"
                onChange={(event) => setTitle(event.target.value)}
              />
              <DateField label="תאריך יעד (לא חובה)" className="min-w-0 flex-[1_1_10rem]" value={dueDate} onChange={setDueDate} />
              {assignees.length > 1 ? (
                <Select aria-label={`אחראי לתת-המשימה: ${taskTitle}`} controlSize="sm" className="w-auto max-w-48" value={ownerId} onChange={(event) => setOwnerId(event.target.value)}>
                  <option value="">אני</option>
                  {assignees.map((a) => (
                    <option key={a.userId} value={a.userId}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Button type="submit" size="sm" variant="secondary" disabled={pending || !title.trim()}>
                הוספה
              </Button>
            </form>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

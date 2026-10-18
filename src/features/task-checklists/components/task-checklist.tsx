"use client";

import { useId, useOptimistic, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";

import { addStepAction, applyTemplateAction, deleteStepAction, toggleStepAction } from "../actions";
import { checklistProgress, CHECKLIST_STEP_MAX, type ChecklistStep } from "../templates";

export type ChecklistTemplateOption = { id: string; name: string };

type Props = {
  orgId: string;
  taskId: string;
  taskTitle: string;
  steps: ChecklistStep[];
  canEdit: boolean;
  templates: ChecklistTemplateOption[];
};

/**
 * The steps inside a task (TASK-06): a line with the progress that opens the list, each step ticked in place, a new
 * step typed in, or a template's steps added at the end.
 */
export function TaskChecklist({ orgId, taskId, taskTitle, steps, canEdit, templates }: Props) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [shown, setShown] = useOptimistic(steps, (current: ChecklistStep[], change: { id: string; done: boolean }) =>
    current.map((s) => (s.id === change.id ? { ...s, done: change.done } : s)),
  );
  const progress = checklistProgress(shown);

  if (!progress && !canEdit) return null;

  function run(action: () => Promise<{ ok: boolean; message?: string }>, after?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.message ?? null);
      else after?.();
    });
  }

  const toggle = (step: ChecklistStep, done: boolean) => {
    setError(null);
    startTransition(async () => {
      setShown({ id: step.id, done });
      const result = await toggleStepAction(orgId, step.id, done);
      if (!result.ok) setError(result.message);
    });
  };

  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(progress && progress.done === progress.total && "text-success")}
      >
        {progress ? `רשימת תיוג: ${progress.text}` : "הוספת רשימת תיוג"}
        <span className="sr-only">: {taskTitle}</span>
      </Button>
      {open ? (
        <div id={panelId} className="mt-2 space-y-3 rounded-md border border-line bg-canvas p-3">
          {shown.length > 0 ? (
            <ul className="space-y-1.5" aria-label={`השלבים של ${taskTitle}`}>
              {shown.map((step) => (
                <li key={step.id} className="flex items-start gap-2">
                  <label className="flex min-w-0 flex-1 items-start gap-2 text-md">
                    <input
                      type="checkbox"
                      checked={step.done}
                      disabled={!canEdit || pending}
                      onChange={(event) => toggle(step, event.target.checked)}
                      className="mt-1 size-4 shrink-0 accent-accent"
                    />
                    <span className={cn("break-words", step.done && "text-ink-soft line-through")}>{step.title}</span>
                  </label>
                  {canEdit ? (
                    <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => deleteStepAction(orgId, step.id))}>
                      הסרה
                      <span className="sr-only">: {step.title}</span>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-soft">אין עדיין שלבים במשימה.</p>
          )}
          {canEdit ? (
            <>
              <form
                className="flex flex-wrap items-center gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!title.trim()) return;
                  run(() => addStepAction(orgId, taskId, title), () => setTitle(""));
                }}
              >
                <Input
                  aria-label={`שלב חדש: ${taskTitle}`}
                  controlSize="sm"
                  className="min-w-0 flex-[1_1_12rem]"
                  value={title}
                  maxLength={CHECKLIST_STEP_MAX}
                  placeholder="שלב חדש"
                  onChange={(event) => setTitle(event.target.value)}
                />
                <Button type="submit" size="sm" variant="secondary" disabled={pending || !title.trim()}>
                  הוספה
                </Button>
              </form>
              {templates.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Select aria-label={`תבנית: ${taskTitle}`} controlSize="sm" className="w-auto max-w-56" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
                    <option value="">שלבים מתבנית</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </Select>
                  <Button size="sm" variant="secondary" disabled={pending || !templateId} onClick={() => run(() => applyTemplateAction(orgId, taskId, templateId), () => setTemplateId(""))}>
                    הוספת השלבים
                  </Button>
                </div>
              ) : null}
            </>
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

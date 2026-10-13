"use client";

import { useRef, useState, type FormEvent, type MouseEvent } from "react";

import { Button } from "@/components/ui/button";

import { closeDateIsOld, oldCloseDateQuestion } from "../close-window";

/**
 * DEAL-04: a close date more than three months back is saved only after the
 * user confirms it. Put `onSubmit` on the close form and render
 * `<OldCloseDateQuestion>` inside it; the form's date field is named closed_date.
 */
export function useOldCloseDate(today: string) {
  // the day the user already confirmed; another day asks again
  const confirmed = useRef<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    const day = String(new FormData(event.currentTarget).get("closed_date") ?? "");
    if (closeDateIsOld(day, today) && confirmed.current !== day) {
      event.preventDefault();
      setAsking(day);
    } else {
      setAsking(null);
    }
  }

  // the "yes" button sits inside the form it submits again
  function confirm(event: MouseEvent<HTMLButtonElement>) {
    confirmed.current = asking;
    setAsking(null);
    event.currentTarget.form?.requestSubmit();
  }

  return { onSubmit, asking, confirm, cancel: () => setAsking(null) };
}

export function OldCloseDateQuestion({ day, onConfirm, onCancel }: { day: string | null; onConfirm: (event: MouseEvent<HTMLButtonElement>) => void; onCancel: () => void }) {
  if (!day) {
    return null;
  }
  return (
    <div role="alert" className="space-y-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
      <p>{oldCloseDateQuestion(day)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={onConfirm} autoFocus>
          כן, לשמור
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          לתקן את התאריך
        </Button>
      </div>
    </div>
  );
}

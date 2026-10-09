"use client";

import { useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";

type Props = {
  // a bound Server Action
  action: () => Promise<ActionResult>;
  children: ReactNode;
  pendingText: string;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "danger-ghost";
  // when set, the first click asks this question and a second click confirms
  confirm?: string;
  // the confirming button's text; by default the button's own text ("מחיקה לצמיתות"), never a bare "כן" (FXU-07)
  confirmLabel?: string;
  // read by screen readers after the visible text, e.g. the row's name
  srLabel?: string;
  disabled?: boolean;
};

/**
 * A small button that runs one Server Action and shows its error under it.
 * With `confirm` it is the one way the app asks before an irreversible step
 * (FXU-07): the question, a button that names the action, and "לא עכשיו",
 * which gets the focus.
 */
export function ActionButton({ action, children, pendingText, variant = "secondary", confirm, confirmLabel, srLabel, disabled }: Props) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await action();
      setAsking(false);
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      {asking ? (
        <span role="group" aria-label={confirm} className="inline-flex flex-wrap items-center gap-2">
          <span className="text-sm">{confirm}</span>
          <Button variant={variant === "danger" || variant === "danger-ghost" ? "danger" : "primary"} size="sm" onClick={run} disabled={pending} aria-busy={pending || undefined}>
            {pending ? pendingText : (confirmLabel ?? (typeof children === "string" ? children : "אישור"))}
          </Button>
          <Button variant="secondary" size="sm" autoFocus onClick={() => setAsking(false)} disabled={pending}>
            לא עכשיו
          </Button>
        </span>
      ) : (
        <Button
          variant={variant}
          size="sm"
          onClick={confirm ? () => setAsking(true) : run}
          disabled={pending || disabled}
          aria-busy={pending || undefined}
        >
          {pending ? pendingText : children}
          {srLabel ? <span className="sr-only">: {srLabel}</span> : null}
        </Button>
      )}
      {error ? (
        <span role="alert" className="max-w-72 text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

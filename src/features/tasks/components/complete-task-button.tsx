"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { completeTaskAction } from "../actions";

/** Marks a task as done. The list re-renders without it when the action succeeds. */
export function CompleteTaskButton({ orgId, taskId, title }: { orgId: string; taskId: string; title: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function complete() {
    setError(null);
    startTransition(async () => {
      const result = await completeTaskAction(orgId, taskId);
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={complete} disabled={pending} aria-busy={pending || undefined}>
        {pending ? "מסמנים…" : "בוצע"}
        <span className="sr-only">: {title}</span>
      </Button>
      {error ? (
        <span role="alert" className="max-w-48 text-end text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

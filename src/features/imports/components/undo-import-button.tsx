"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";

import { undoImportAction } from "../actions";

type Props = { orgId: string; jobId: string; question: string; fileName: string };

/**
 * "ביטול הייבוא" with its question, like ActionButton, and the answer shown under it:
 * a member's undo may keep records that changed since (PRM-01, "לא בוטלו: N").
 */
export function UndoImportButton({ orgId, jobId, question, fileName }: Props) {
  const [pending, startTransition] = useTransition();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function run() {
    setError(null);
    startTransition(async () => {
      const result = await undoImportAction(orgId, jobId);
      setAsking(false);
      if (result.ok) setNotice(result.message ?? null);
      else setError(result.message);
    });
  }

  return (
    <span className="inline-flex max-w-72 flex-col items-start gap-1">
      {asking ? (
        <span role="group" aria-label={question} className="inline-flex flex-wrap items-center gap-2">
          <span className="text-sm">{question}</span>
          <Button variant="danger" size="sm" onClick={run} disabled={pending} aria-busy={pending || undefined}>
            {pending ? "מבטלים…" : "ביטול הייבוא"}
          </Button>
          <Button variant="secondary" size="sm" autoFocus onClick={() => setAsking(false)} disabled={pending}>
            לא עכשיו
          </Button>
        </span>
      ) : notice ? null : (
        <Button variant="danger-ghost" size="sm" onClick={() => setAsking(true)}>
          ביטול הייבוא
          <span className="sr-only">: {fileName}</span>
        </Button>
      )}
      <FormError message={error} className="text-sm" />
      <FormNotice message={notice} className="text-sm" />
    </span>
  );
}

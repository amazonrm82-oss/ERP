"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { TrashIcon } from "@/components/ui/icons";
import type { ActionResult } from "@/lib/action-result";

type Props = {
  // "הליד", "איש הקשר", "החברה", "העסקה"
  noun: string;
  // a bound Server Action; on success it redirects to the list
  action: () => Promise<ActionResult>;
};

/** Move-to-recycle-bin with a confirm step. */
export function TrashRecordButton({ noun, action }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await action();
      // only reached when the action did not redirect
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  if (!confirming) {
    return (
      <Button variant="danger-ghost" size="sm" onClick={() => setConfirming(true)}>
        <TrashIcon className="size-4.5" />
        העברה לסל המחזור
      </Button>
    );
  }

  return (
    <div role="group" aria-labelledby="trash-confirm-title" className="rounded-lg border border-line bg-surface p-4">
      <p id="trash-confirm-title" className="font-medium">
        להעביר את {noun} לסל המחזור?
      </p>
      <p className="mt-1 text-sm text-ink-soft">
        הרשומה תוסר מהרשימות. אפשר לשחזר מסל המחזור במשך 30 יום.
      </p>
      <FormError message={error} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="danger" size="sm" onClick={confirm} disabled={pending} aria-busy={pending || undefined}>
          {pending ? "מעביר…" : "העברה לסל המחזור"}
        </Button>
        {/* focus lands on the safe choice */}
        <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirming(false)} disabled={pending}>
          לא עכשיו
        </Button>
      </div>
    </div>
  );
}

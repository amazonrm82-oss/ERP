"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { TrashIcon } from "@/components/ui/icons";

import { trashLeadAction } from "../actions";

/** Move-to-recycle-bin with a confirm step. On success the action redirects to the leads list. */
export function TrashLeadButton({ orgId, leadId }: { orgId: string; leadId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await trashLeadAction(orgId, leadId);
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
        להעביר את הליד לסל המחזור?
      </p>
      <p className="mt-1 text-sm text-ink-soft">הליד יוסר מהרשימות ויישמר בסל המחזור 30 יום לפני מחיקה סופית.</p>
      <FormError message={error} className="mt-3" />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="danger" size="sm" onClick={confirm} disabled={pending} aria-busy={pending || undefined}>
          {pending ? "מעביר…" : "כן, להעביר לסל"}
        </Button>
        {/* focus lands on the safe choice */}
        <Button variant="secondary" size="sm" autoFocus onClick={() => setConfirming(false)} disabled={pending}>
          ביטול
        </Button>
      </div>
    </div>
  );
}

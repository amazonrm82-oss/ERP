"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";

import { cancelBackgroundRequestAction, orderFullExportAction } from "../actions";

/** IMP-04: "הכנה ברקע" next to the full export's direct download. */
export function OrderExportButton({ orgId }: { orgId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <span className="inline-flex max-w-80 flex-col items-start gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={() => {
          setError(null);
          setNotice(null);
          startTransition(async () => {
            const result = await orderFullExportAction(orgId);
            if (result.ok) setNotice(result.message ?? null);
            else setError(result.message);
          });
        }}
      >
        {pending ? "מזמינים…" : "הכנה ברקע"}
      </Button>
      <FormNotice message={notice} />
      <FormError message={error} />
    </span>
  );
}

/** Cancels an order that has not ended. */
export function CancelBackgroundButton({ orgId, requestId }: { orgId: string; requestId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const result = await cancelBackgroundRequestAction(orgId, requestId);
            if (!result.ok) setError(result.message);
          });
        }}
      >
        {pending ? "מבטלים…" : "ביטול"}
      </Button>
      <FormError message={error} />
    </span>
  );
}

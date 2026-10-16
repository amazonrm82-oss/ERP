"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";

import { createQuoteAction } from "../actions";

/** QUO-01: a new draft quote for this deal or contact; the editor opens when it is made. */
export function NewQuoteButton({ orgId, source }: { orgId: string; source: { kind: "deal" | "contact"; id: string } }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        className="print:hidden"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            const outcome = await createQuoteAction(orgId, source);
            // success navigates to the editor; only a refusal comes back
            if (outcome && !outcome.ok) setError(outcome.message);
          });
        }}
      >
        <PlusIcon className="size-4" />
        {pending ? "יוצרים…" : "הצעה חדשה"}
      </Button>
      <FormError message={error} />
    </span>
  );
}

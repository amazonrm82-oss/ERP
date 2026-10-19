"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";

import { createOrderAction } from "../actions";

type Props = { orgId: string; source: { kind: "deal" | "contact" | "company"; id: string } };

/** ORD-01: a manual draft order for this deal, contact or company; the order page opens. */
export function NewOrderButton({ orgId, source }: Props) {
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
            const outcome = await createOrderAction(orgId, source);
            // success navigates to the order; only a refusal comes back
            if (outcome && !outcome.ok) setError(outcome.message);
          });
        }}
      >
        <PlusIcon className="size-4" />
        {pending ? "יוצרים…" : "הזמנה חדשה"}
      </Button>
      <FormError message={error} />
    </span>
  );
}

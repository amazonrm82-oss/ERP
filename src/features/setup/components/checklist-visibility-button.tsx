"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";

import { setChecklistHiddenAction } from "../checklist-actions";

type Props = { orgId: string; hidden: boolean; children: string; variant?: "ghost" | "secondary" };

/** Closes the setup checklist on the home page (hidden = true), or shows it there again. */
export function ChecklistVisibilityButton({ orgId, hidden, children, variant = "ghost" }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Button
        variant={variant}
        size="sm"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await setChecklistHiddenAction(orgId, hidden);
            if (!result.ok) {
              setError(result.message);
            }
          })
        }
      >
        {children}
      </Button>
      <FormError message={error} className="basis-full" />
    </>
  );
}

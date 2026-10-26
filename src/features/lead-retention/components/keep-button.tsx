"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { keepRetentionLeadAction } from "../actions";

/** PRV-01: "להשאיר" one lead of the open round's list. */
export function KeepButton({ orgId, leadId, name }: { orgId: string; leadId: string; name: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        size="sm"
        loading={pending}
        aria-label={`להשאיר: ${name}`}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await keepRetentionLeadAction(orgId, leadId);
            if (!result.ok) setError(result.message);
          })
        }
      >
        להשאיר
      </Button>
      {error ? (
        <span role="alert" className="text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

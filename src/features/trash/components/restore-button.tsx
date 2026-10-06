"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import type { TrashableTable } from "@/lib/record-trash";

import { restoreRecordAction } from "../actions";

export function RestoreButton({ orgId, table, id, name }: { orgId: string; table: TrashableTable; id: string; name: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function restore() {
    setError(null);
    startTransition(async () => {
      const result = await restoreRecordAction(orgId, table, id);
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Button variant="secondary" size="sm" onClick={restore} disabled={pending} aria-busy={pending || undefined}>
        {pending ? "משחזר…" : "שחזור"}
        <span className="sr-only">: {name}</span>
      </Button>
      {error ? (
        <span role="alert" className="max-w-56 text-end text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

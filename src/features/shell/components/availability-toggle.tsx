"use client";

import { useState, useTransition } from "react";

import { setAvailabilityAction } from "@/features/settings/actions";

type Props = { orgId: string; userId: string; available: boolean };

/** "On vacation" switch in the account menu: an unavailable user is skipped by the lead round robin. */
export function AvailabilityToggle({ orgId, userId, available }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // shown at once; put back if the save fails
  const [value, setValue] = useState(available);

  return (
    <div className="px-4 py-2">
      <label className="flex cursor-pointer items-center justify-between gap-3 text-md">
        <span>זמין לקבלת לידים</span>
        <input
          type="checkbox"
          role="switch"
          checked={value}
          disabled={pending}
          onChange={(event) => {
            const next = event.target.checked;
            setError(null);
            setValue(next);
            startTransition(async () => {
              const result = await setAvailabilityAction(orgId, userId, next);
              if (!result.ok) {
                setValue(!next);
                setError(result.message);
              }
            });
          }}
          className="size-4.5 accent-accent"
        />
      </label>
      {value ? null : <p className="mt-1 text-sm text-ink-soft">לידים חדשים בסבב לא יגיעו אליך.</p>}
      {error ? (
        <p role="alert" className="mt-1 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

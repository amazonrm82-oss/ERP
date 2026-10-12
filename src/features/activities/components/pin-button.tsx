"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { setActivityPinnedAction } from "../actions";
import type { TimelineSubject } from "../schema";

type Props = {
  orgId: string;
  subject: TimelineSubject;
  activityId: string;
  pinned: boolean;
  // what the entry is ("הערה", "שיחה"), so a screen reader knows which one the button acts on
  label: string;
};

/** REC-01: pins an entry to the top of the timeline, or unpins it. The page re-renders on success. */
export function PinButton({ orgId, subject, activityId, pinned, label }: Props) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await setActivityPinnedAction(orgId, subject, activityId, !pinned);
      if (!result.ok) {
        setError(result.message);
      }
    });
  }

  return (
    <span className="flex shrink-0 flex-col items-end gap-1">
      <Button variant="ghost" size="sm" onClick={toggle} loading={pending}>
        {pinned ? "ביטול הנעיצה" : "נעיצה"}
        <span className="sr-only">: {label}</span>
      </Button>
      {error ? (
        <span role="alert" className="max-w-48 text-end text-sm text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

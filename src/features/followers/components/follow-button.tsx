"use client";

import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { BellIcon } from "@/components/ui/icons";
import type { TimelineSubject } from "@/features/activities/schema";

import { setFollowAction } from "../actions";
import type { FollowState } from "../queries";

type Props = {
  orgId: string;
  subject: TimelineSubject;
  state: FollowState;
};

function followersText(count: number): string {
  if (count === 0) return "אין עוקבים";
  if (count === 1) return "עוקב אחד";
  return `${count} עוקבים`;
}

/**
 * REC-03: "מעקב" / "הפסקת מעקב" on a record page, with the number of followers. A follower is told
 * about a status or stage change, an owner change and a new entry on the record.
 */
export function FollowButton({ orgId, subject, state }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const hintId = useId();

  function toggle() {
    setError(null);
    startTransition(async () => {
      const result = await setFollowAction(orgId, subject, !state.following);
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={toggle}
          loading={pending}
          aria-describedby={hintId}
        >
          {pending ? null : <BellIcon className="size-4" />}
          {state.following ? "הפסקת מעקב" : "מעקב"}
        </Button>
        <span className="text-sm text-ink-soft">{followersText(state.count)}</span>
      </div>
      <span id={hintId} className="sr-only">
        עוקבים מקבלים התראה על שינוי סטטוס או שלב, החלפת אחראי ופעילות חדשה ברשומה.
      </span>
      <FormError message={error} />
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import type { TimelineSubject } from "@/features/activities/schema";

import { deleteFollowingMeetingsAction, seriesDeleteCountAction } from "../actions";

type Props = {
  orgId: string;
  meetingId: string;
  subject: TimelineSubject | null;
  // done: what happened (null = all deleted), for the caller to show
  onDone: (message?: string) => void;
};

/**
 * CAL-09 (owner, 15 October 2026): "מחיקת הפגישה הזו וכל הבאות", for a series made by mistake.
 * The window counts the meetings first; each one is deleted by its own rights.
 */
export function DeleteFollowingButton({ orgId, meetingId, subject, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<{ count: number; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function ask() {
    setError(null);
    setInfo(null);
    setOpen(true);
    startTransition(async () => {
      const answer = await seriesDeleteCountAction(orgId, meetingId);
      if (answer.ok && answer.data) setInfo(answer.data);
      else setError(answer.ok ? "לא מצאנו את הפגישות." : answer.message);
    });
  }

  function remove() {
    startTransition(async () => {
      const answer = await deleteFollowingMeetingsAction(orgId, meetingId, subject);
      if (!answer.ok) {
        setError(answer.message);
        return;
      }
      setOpen(false);
      onDone(answer.message);
    });
  }

  return (
    <>
      <Button variant="danger-ghost" size="sm" onClick={ask}>
        מחיקת הפגישה הזו וכל הבאות
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="למחוק את הפגישה הזו וכל הבאות?">
        <div className="space-y-4">
          {info === null && !error ? (
            <p role="status" className="text-sm text-ink-soft">
              סופרים את הפגישות…
            </p>
          ) : null}
          {info ? <p className="text-md">{info.text}</p> : null}
          <FormError message={error} />
          <div className="flex flex-wrap gap-2">
            <Button variant="danger" onClick={remove} disabled={!info || info.count === 0 || pending} loading={pending && info !== null}>
              {info && info.count > 1 ? `מחיקת ${info.count} פגישות` : "מחיקה"}
            </Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              ביטול
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

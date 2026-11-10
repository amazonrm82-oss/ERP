"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { QUEUE_MEMORY_ON, queueMemoryKey, queueMemoryStep, type QueueState } from "../queue";

type Props = {
  orgId: string;
  userId: string;
  canWrite: boolean;
  state: QueueState;
  left: boolean;
  // the first waiting lead in the queue, or null when nothing waits
  resumeHref: string | null;
};

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // private window or blocked storage: the queue simply is not remembered on this device
  }
}

/**
 * UX-02, owner (238) א: remembers on this device, per business and user, whether the queue was left on. Opening the
 * waiting screen again resumes it; "יציאה ממצב תור" or closing the end panel forgets it. Renders nothing.
 */
export function QueueMemory({ orgId, userId, canWrite, state, left, resumeHref }: Props) {
  const router = useRouter();
  useEffect(() => {
    const key = queueMemoryKey(orgId, userId);
    const step = queueMemoryStep({ canWrite, state, left, stored: readStored(key), hasLead: resumeHref !== null });
    if (step === "remember") writeStored(key, QUEUE_MEMORY_ON);
    else if (step === "forget") writeStored(key, null);
    else if (step === "resume" && resumeHref) router.replace(resumeHref, { scroll: false });
  }, [orgId, userId, canWrite, state, left, resumeHref, router]);
  return null;
}

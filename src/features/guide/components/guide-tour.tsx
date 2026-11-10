"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

import { markGuideTourSeenAction } from "../actions";
import { TOUR_REPLAY_EVENT, tourMarksSeen, tourProgress, tourStartsByItself, tourStepAfter, type ResolvedTourStep } from "../tour";

type Props = {
  orgId: string;
  steps: ResolvedTourStep[];
  // when the person finished or skipped the tour; null = never
  seenAt: string | null;
  // a support session: the tour never opens by itself and never marks anything
  support: boolean;
};

/**
 * UX-05 (א): the first-visit tour, five short steps in a window. It opens by itself once (tourStartsByItself), can be
 * skipped at any step, and opens again from the account menu ("סיור במערכת", TOUR_REPLAY_EVENT). Finishing or skipping
 * marks it seen on the person's own profile; a replay changes nothing.
 */
export function GuideTour({ orgId, steps, seenAt, support }: Props) {
  const pathname = usePathname();
  // The frame stays mounted while the person moves around, so whether the tour opens by itself is judged on every screen,
  // not only the first one: a new owner lands on the setup wizard first (no tour there) and meets the tour on the next
  // screen. Once it was closed (or opened from the menu) it never opens by itself again in this frame.
  const [dismissed, setDismissed] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [index, setIndex] = useState(0);
  const marked = useRef(seenAt !== null);
  const open = replaying || (!dismissed && tourStartsByItself({ seenAt, support, pathname }));

  useEffect(() => {
    function replay() {
      setIndex(0);
      setReplaying(true);
    }
    window.addEventListener(TOUR_REPLAY_EVENT, replay);
    return () => window.removeEventListener(TOUR_REPLAY_EVENT, replay);
  }, []);

  function close() {
    setDismissed(true);
    setReplaying(false);
    setIndex(0);
    if (!marked.current && tourMarksSeen(support)) {
      marked.current = true;
      // a failure only means the tour may open again next time
      void markGuideTourSeenAction(orgId);
    }
  }

  const step = steps[index];
  if (!step) return null;
  const last = index === steps.length - 1;

  return (
    <Dialog
      open={open}
      onClose={close}
      title={step.title}
      description={tourProgress(index, steps.length)}
      footer={
        <>
          <Button variant="ghost" onClick={close} className="me-auto">
            {last ? "סגירה" : "דילוג על הסיור"}
          </Button>
          {index > 0 ? (
            <Button variant="secondary" onClick={() => setIndex(tourStepAfter(index, -1, steps.length) ?? 0)}>
              הקודם
            </Button>
          ) : null}
          <Button
            key={index}
            autoFocus
            data-autofocus
            onClick={() => {
              const next = tourStepAfter(index, 1, steps.length);
              if (next === null) close();
              else setIndex(next);
            }}
          >
            {last ? "סיום" : "הבא"}
          </Button>
        </>
      }
    >
      <div className="space-y-2 text-md">
        {step.body.map((p) => (
          <p key={p}>{p}</p>
        ))}
      </div>
      {/* the step is also said in words, in the window's description */}
      <div aria-hidden="true" className="mt-4 flex justify-center gap-1.5">
        {steps.map((s, i) => (
          <span key={s.key} className={i === index ? "h-2 w-5 rounded-full bg-accent" : "size-2 rounded-full bg-line-strong"} />
        ))}
      </div>
    </Dialog>
  );
}

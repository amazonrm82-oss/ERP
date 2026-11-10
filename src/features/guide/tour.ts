// UX-05: the parts of the in-app guide the browser needs: the tour's state rules and the shapes the server hands over.
// Client-safe on purpose: it never imports the help content (content.generated.ts), so the help corpus stays out of the
// client bundle; the server resolves the texts (guide.ts) and passes only the ones a page shows.

import type { TourStep } from "@/features/help/content";

/** The account menu's "replay the tour" asks the tour, which lives in the business frame, to open through this event. */
export const TOUR_REPLAY_EVENT = "mx:guide-tour";

/**
 * Whether the tour opens by itself: never seen, not in a support session (staff only look and never mark anything for the
 * customer's people) and not on the setup wizard (the wizard is the first thing a new owner does; the tour waits for the
 * next screen).
 */
export function tourStartsByItself({ seenAt, support, pathname }: { seenAt: string | null; support: boolean; pathname: string }): boolean {
  if (seenAt !== null || support) return false;
  return !/^\/o\/[^/]+\/setup(\/|$)/.test(pathname);
}

/** Whether closing the tour should save it as seen: a support session never writes the customer's people's profiles. */
export function tourMarksSeen(support: boolean): boolean {
  return !support;
}

/** The step after moving by `by` (+1 next, -1 back), kept inside the tour; null after the last step = done. */
export function tourStepAfter(index: number, by: 1 | -1, length: number): number | null {
  const next = index + by;
  if (next < 0) return 0;
  if (next >= length) return null;
  return next;
}

/** "שלב 2 מתוך 5" */
export function tourProgress(index: number, length: number): string {
  return `שלב ${index + 1} מתוך ${length}`;
}

export type ResolvedTourStep = Omit<TourStep, "title" | "body"> & { title: string; body: string[] };

export type ResolvedScreenHelp = { title: string; lines: [string, string, string]; article: string; video: string | null };

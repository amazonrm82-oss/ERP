// CAL-02 (owner, 12 October 2026): on a touch screen a calendar item is moved
// by a long press and then a drag; a finger that moves before the press is
// long enough is scrolling, and a short tap opens the item. Pure, so the
// decision is unit-tested; the board feeds it the finger's distance and time.

// how long the finger must rest on the item before it lifts
export const LONG_PRESS_MS = 450;
// how far (CSS pixels) the finger may wander before that and still count as resting
export const LONG_PRESS_SLOP = 8;

export type PressOutcome = "wait" | "cancel" | "lift";

/**
 * What a touch on an item has become: "cancel" once the finger moved past the
 * slop (the page scrolls as usual), "lift" once it rested long enough (the drag
 * starts), "wait" until one of the two happens. Moving wins over time, so a
 * swipe that lasts long is still a scroll.
 */
export function pressOutcome(distance: number, elapsed: number): PressOutcome {
  if (!Number.isFinite(distance) || distance > LONG_PRESS_SLOP) return "cancel";
  if (elapsed >= LONG_PRESS_MS) return "lift";
  return "wait";
}

/** The distance between where the finger came down and where it is now. */
export function pressDistance(start: { x: number; y: number }, now: { x: number; y: number }): number {
  return Math.hypot(now.x - start.x, now.y - start.y);
}

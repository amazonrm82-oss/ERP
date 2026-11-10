// UX-02: "מצב תור" on the waiting leads screen. After an action in the side panel, the next waiting lead opens in it.
// Pure rules (unit-tested); the address carries the mode, so a refresh or the back button keeps it.

import { peekHref } from "./model";

/** The address parameter: "1" = the queue is on, "end" = the queue reached its end (no lead open). */
export const QUEUE_PARAM = "queue";

export type QueueState = "on" | "end" | null;

type Query = Record<string, string | string[] | undefined>;

/** The queue's state from the page's search parameters; anything else is off. */
export function queueState(query: Query): QueueState {
  const raw = query[QUEUE_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === "1" ? "on" : value === "end" ? "end" : null;
}

/**
 * The lead the queue opens after an action on `currentId`, in the list's own order (the waiting list: the one waiting
 * longest first): the one right after it, else null (the end of the queue). A lead that is no longer on the list (it
 * was answered and the list was read again) leaves no place to continue from, so the queue goes on from the top,
 * skipping the lead itself.
 */
export function queueNextId(ids: ReadonlyArray<string>, currentId: string): string | null {
  const at = ids.indexOf(currentId);
  if (at >= 0) return at < ids.length - 1 ? ids[at + 1] : null;
  return ids.find((id) => id !== currentId) ?? null;
}

/** "3 מתוך 12" for the lead open in the queue; null when it is not on the list. */
export function queuePosition(ids: ReadonlyArray<string>, id: string): { at: number; total: number } | null {
  const at = ids.indexOf(id);
  return at < 0 ? null : { at: at + 1, total: ids.length };
}

/** The list's address with the queue set to a state and a lead open (or none), keeping every other parameter. */
export function queueHref(listPath: string, params: URLSearchParams, state: QueueState | "off", leadId: string | null): string {
  const next = new URLSearchParams(params);
  next.delete(QUEUE_PARAM);
  if (state) next.set(QUEUE_PARAM, state === "on" ? "1" : state);
  return peekHref(listPath, next, leadId);
}

/**
 * "יציאה ממצב תור" (and closing the end panel) goes to ?queue=off: the queue is off like with no parameter, and the
 * page also forgets the remembered choice (owner (238) א). A screen opened without the parameter may resume the queue.
 */
export function queueLeft(query: Query): boolean {
  const raw = query[QUEUE_PARAM];
  return (Array.isArray(raw) ? raw[0] : raw) === "off";
}

/** The device's memory of the choice (owner (238) א): one key per business and user, in localStorage. */
export function queueMemoryKey(orgId: string, userId: string): string {
  return `mx-lead-queue:${orgId}:${userId}`;
}

/** The stored value while the queue was last left on. */
export const QUEUE_MEMORY_ON = "1";

export type QueueMemoryStep = "remember" | "forget" | "resume" | "none";

/**
 * What the waiting screen does with the remembered choice when it opens: in the queue = remember it; left the queue
 * = forget it; opened without a choice while the queue was last left on, with a lead waiting = resume the queue at
 * the first waiting lead; anything else = nothing. Someone who cannot write never uses the queue.
 */
export function queueMemoryStep(input: { canWrite: boolean; state: QueueState; left: boolean; stored: string | null; hasLead: boolean }): QueueMemoryStep {
  if (!input.canWrite) return "none";
  if (input.left) return "forget";
  if (input.state !== null) return "remember";
  return input.stored === QUEUE_MEMORY_ON && input.hasLead ? "resume" : "none";
}

export type QueueLinks = {
  // where the panel goes after an action: the next lead in the queue, or the end of the queue
  afterHref: string;
  // "3 מתוך 12"
  position: { at: number; total: number } | null;
};

/** The panel's queue links for the lead open in it (`params` are the page's parameters without `peek`). */
export function queueLinks(listPath: string, params: URLSearchParams, ids: ReadonlyArray<string>, currentId: string): QueueLinks {
  const next = queueNextId(ids, currentId);
  return {
    afterHref: next ? queueHref(listPath, params, "on", next) : queueHref(listPath, params, "end", null),
    position: queuePosition(ids, currentId),
  };
}

/** Hebrew: the queue's place line in the panel. */
export function queuePositionText(position: { at: number; total: number } | null): string {
  return position ? `מצב תור · ${position.at} מתוך ${position.total}` : "מצב תור";
}

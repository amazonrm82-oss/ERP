// The setup wizard (USR-03): four steps after a business is created. Every step
// can be skipped, and the wizard can be left and resumed. The organization keeps
// the next step in organizations.setup_step (1..4; null = finished or skipped),
// which owners and admins may write (migration 0101).

export const SETUP_STEPS = [
  { step: 1, title: "פרטי העסק" },
  { step: 2, title: "ענף ורשימות" },
  { step: 3, title: "ייבוא נתונים" },
  { step: 4, title: "הזמנת הצוות" },
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number]["step"];

export const SETUP_STEP_COUNT = SETUP_STEPS.length;

export function isSetupStep(value: unknown): value is SetupStep {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= SETUP_STEP_COUNT;
}

export function setupStepTitle(step: SetupStep): string {
  return SETUP_STEPS[step - 1].title;
}

/**
 * How leaving `done` forward (saved or skipped) writes the progress, in one
 * conditional update: the next step only where the stored one is below it
 * (progress never moves back, and a finished wizard, null, stays finished);
 * leaving the last step finishes the wizard (null).
 */
export function progressWrite(done: SetupStep): { setTo: SetupStep; onlyBelow: true } | { setTo: null; onlyBelow: false } {
  const next = stepAfter(done);
  return next === null ? { setTo: null, onlyBelow: false } : { setTo: next, onlyBelow: true };
}

/** After a conditional progress write touched no row: true when the stored progress was already there or further. */
export function alreadyPast(stored: number | null, next: SetupStep): boolean {
  return stored === null || stored >= next;
}

/** The organization statuses that can be written to (mirrors canWrite in getOrgContext). */
export const WRITABLE_ORG_STATUSES: readonly string[] = ["trial", "active", "past_due"];

/** Where a step leads after it is saved or skipped: the next step, or null for "back to the app". */
export function stepAfter(done: SetupStep): SetupStep | null {
  return done >= SETUP_STEP_COUNT ? null : ((done + 1) as SetupStep);
}

/**
 * The step a visit shows: the one asked for in the address (any step may be
 * opened again), else the stored progress. Null = nothing to show (finished).
 */
export function stepToShow(stored: number | null, requested: string | string[] | undefined): SetupStep | null {
  const asked = typeof requested === "string" && /^\d$/.test(requested) ? Number(requested) : null;
  if (isSetupStep(asked)) {
    return asked;
  }
  return isSetupStep(stored) ? stored : null;
}

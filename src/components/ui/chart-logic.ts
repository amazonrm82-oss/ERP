/**
 * DSN-13: the arithmetic of the one chart style (src/components/ui/chart.tsx), kept pure so it is unit-tested.
 *
 * A bar's length is a share of 0..100 percent. A positive value never draws thinner than MIN_VISIBLE_PERCENT,
 * so "a little" is never mistaken for "none"; zero, a negative value, or a value that is not a number draws
 * nothing (its number is still in the text beside it).
 */
export const MIN_VISIBLE_PERCENT = 2;

/** Length of a bar compared with the largest value in its chart (comparison bars). */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 0) return 0;
  return Math.max(MIN_VISIBLE_PERCENT, Math.min(100, (value / max) * 100));
}

/** Length of a meter or progress bar (`value` out of `max`), whole percent, 0..100. */
export function meterPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || value <= 0 || max <= 0) return 0;
  return Math.max(MIN_VISIBLE_PERCENT, Math.min(100, Math.round((value / max) * 100)));
}

/** The largest value of a chart (0 when there is nothing positive), the scale of its comparison bars. */
export function chartMax(values: readonly unknown[]): number {
  let max = 0;
  for (const value of values) if (typeof value === "number" && Number.isFinite(value) && value > max) max = value;
  return max;
}

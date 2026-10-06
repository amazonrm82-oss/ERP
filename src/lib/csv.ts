// Shared CSV helpers. Excel runs a cell that starts with = + - or @ as a formula,
// so such text gets a leading apostrophe. A plain number with a sign ("+972501234567",
// "-120") is left alone: it cannot carry a formula.
const FORMULA_START = /^[=+\-@\t\r]/;
const SIGNED_NUMBER = /^[+-][\d\s().-]*$/;

export function defuseFormula(text: string): string {
  return FORMULA_START.test(text) && !SIGNED_NUMBER.test(text) ? `'${text}` : text;
}

/** One CSV cell: quoted when needed, formulas defused. */
export function csvText(text: string): string {
  const safe = defuseFormula(text);
  return /[",\r\n]/.test(safe) || safe !== text ? `"${safe.replace(/"/g, '""')}"` : safe;
}

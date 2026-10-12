/**
 * Israeli ID numbers (ת"ז) and company / dealer numbers (ח.פ., ע.מ.) share one
 * format: 9 digits, the last a check digit (CON-04). Shorter numbers are padded
 * with leading zeros; all zeros is refused. Mirrored in the database by app.valid_israeli_id().
 */

/** The 9 digits of a valid number (spaces and dashes ignored), or null. */
export function israeliIdNumber(text: string): string | null {
  const digits = text.replace(/[\s-]/g, "");
  if (!/^\d{5,9}$/.test(digits)) return null;
  const padded = digits.padStart(9, "0");
  // all zeros passes the check digit but is never a real number
  if (padded === "000000000") return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const step = Number(padded[i]) * ((i % 2) + 1);
    sum += step > 9 ? step - 9 : step;
  }
  return sum % 10 === 0 ? padded : null;
}

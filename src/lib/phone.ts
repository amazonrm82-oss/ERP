/**
 * Israeli phone numbers to E.164: the same rules as app.normalize_phone() in
 * the database (tests/db/10-phone-parity.test.ts keeps the two in step).
 * Returns null when the input has no digits.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }
  const plus = input.trim().startsWith("+");
  const digits = input.replace(/[^0-9]/g, "");
  if (digits === "") {
    return null;
  }
  if (plus) {
    return `+${digits}`;
  }
  if (digits.startsWith("00")) {
    return `+${digits.slice(2)}`;
  }
  if (digits.startsWith("972") && digits.length >= 11 && digits.length <= 12) {
    return `+${digits}`;
  }
  if (digits.startsWith("0") && digits.length >= 9 && digits.length <= 10) {
    return `+972${digits.slice(1)}`;
  }
  return `+${digits}`;
}

/**
 * "YYYY-MM-DD" that is a real day: 2026-02-30 and 2026-13-01 are refused
 * (FXC-08). JavaScript's Date rolls them over to another day instead.
 * The database checks custom field dates the same way (migration 0026).
 */
export function isCalendarDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

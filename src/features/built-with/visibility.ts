// "נבנה ב-Mexuz" on customer-facing pages (FLD-04, owner 13 October 2026): the
// public lead form now, the booking page when it is built. The database decides
// (app.show_built_with: shown unless the plan or the organization's override turns
// remove_built_with on; a business on trial keeps the line whatever its plan, and an
// override alone decides when set); a page shows the line only on an explicit true, so a
// missing or unknown answer never shows it on a page whose business removed it.

/** Whether a page shows the line, from the database's answer (true = show). */
export function builtWithVisible(answer: unknown): boolean {
  return answer === true;
}

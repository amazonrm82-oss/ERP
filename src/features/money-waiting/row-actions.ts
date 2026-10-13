// MNY-02: the action of a row of "כסף שמחכה". In wave 2: create a task, hand the record to a
// rep, or open WhatsApp with a template. Pure, so unit tests and client code can use it.

export type RowAction = "assign" | "whatsapp" | "task";

export const ROW_ACTION_LABELS: Record<RowAction, string> = {
  assign: "הקצאה לנציג",
  whatsapp: "WhatsApp",
  task: "משימה",
};

/**
 * The actions a row offers, the one that fits best first: a record with no owner is handed to a
 * rep first; a lead with a phone gets a WhatsApp message (it has not been answered); otherwise a
 * task for the next step. Only what the user may do (hints: the database decides).
 */
export function rowActions(row: {
  kind: "lead" | "deal";
  ownerId: string | null;
  // a usable WhatsApp number (the lead's, or the deal's contact's)
  phoneE164: string | null;
  canWrite: boolean;
  // may hand the record to someone else (managers and up who may edit it)
  canReassign: boolean;
}): RowAction[] {
  if (!row.canWrite) return [];
  const available: RowAction[] = ["task"];
  if (row.phoneE164) available.push("whatsapp");
  if (row.canReassign) available.push("assign");

  let first: RowAction;
  if (row.ownerId === null && row.canReassign) first = "assign";
  else if (row.kind === "lead" && row.phoneE164) first = "whatsapp";
  else first = "task";
  return [first, ...available.filter((action) => action !== first)];
}

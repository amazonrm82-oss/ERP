// LEAD-06: where each lead custom field goes when a lead is converted.
// The database decides at conversion time (app.carry_custom_fields, migration
// lead_convert_map) and saves the screen (public.save_conversion_field_map);
// these rules build the settings screen and check the form before it is sent.
//   no row, or mode "auto"   the field with the same label and type (0029),
//                            never a field another lead field picked by hand
//   mode "none"              not copied to that record type
//   mode "field"             that field, while it is active and of the same type

export const MAP_TARGETS = ["contact", "deal"] as const;
export type MapTarget = (typeof MAP_TARGETS)[number];

export const MAP_TARGET_LABELS: Record<MapTarget, string> = { contact: "איש קשר", deal: "עסקה" };

export const AUTO = "auto";
export const NONE = "none";
// the stored target was deleted (owner, 13 October 2026): shown until a person picks again; sending it changes nothing
export const REMOVED = "removed";
export type MapChoice = typeof AUTO | typeof NONE | typeof REMOVED | string;

/** Shown on the mapping screen next to a lead field whose target was deleted. */
export const TARGET_REMOVED_NOTE = "השדה נמחק. הערך לא מועבר. בחרו שדה אחר או הסירו את השורה.";

/**
 * The question before a custom field that receives a lead field's value is
 * hidden: hiding it also stops the value from carrying.
 */
export function targetHideWarning(leadFieldLabel: string, type: MapTarget): string {
  return `השדה הזה מקבל ערכים מלידים בהמרה. אחרי ההסתרה הערך של ${leadFieldLabel} לא יועבר ${type === "deal" ? "לעסקה" : "לאיש הקשר"}.`;
}

/** Owners and admins see it on the settings page while any target is deleted. */
export const TARGET_REMOVED_REMINDER = "שדה שקיבל ערכים מלידים בהמרה נמחק, ולכן הערך לא מועבר.";

/**
 * The warning before a custom field that receives a lead field's value is
 * deleted (owner, 13 October 2026). Only one lead field can point at a field.
 */
export function targetDeleteWarning(leadFieldLabel: string, type: MapTarget): string {
  return `השדה הזה מקבל ערכים מלידים בהמרה. אחרי המחיקה הערך של ${leadFieldLabel} לא יועבר ${type === "deal" ? "לעסקה" : "לאיש הקשר"}.`;
}

export type MapField = { id: string; label: string; type: string; isActive: boolean };

export type MapMode = "auto" | "none" | "field";
export type MapRow = {
  id: string;
  leadFieldId: string;
  targetType: MapTarget;
  mode: MapMode;
  targetFieldId: string | null;
  // set by the database when the picked field was deleted; cleared by any write of a person
  targetRemoved: boolean;
};

/** Whether the reminder shows: a lead field whose picked target was deleted and nobody chose again. */
export function mappingNeedsFix(rows: MapRow[]): boolean {
  return rows.some((r) => r.targetRemoved);
}

export function isMapTarget(value: string): value is MapTarget {
  return (MAP_TARGETS as readonly string[]).includes(value);
}

export function isMapMode(value: string): value is MapMode {
  return value === "auto" || value === "none" || value === "field";
}

const sameLabel = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The fields a lead field may go to: active, same type. `targets` come in screen order (position, created_at). */
export function offeredTargets(lead: MapField, targets: MapField[]): MapField[] {
  return targets.filter((t) => t.isActive && t.type === lead.type);
}

/** The fields of one record type that a lead field picked by hand: "auto" never reaches them. */
export function claimedTargets(rows: MapRow[], type: MapTarget): Set<string> {
  return new Set(rows.flatMap((r) => (r.targetType === type && r.mode === "field" && r.targetFieldId ? [r.targetFieldId] : [])));
}

/**
 * What "auto" resolves to: the first active field with the same label and type
 * that no lead field picked by hand, as the database picks it.
 */
export function autoTarget(lead: MapField, targets: MapField[], claimed: Set<string> = new Set()): MapField | null {
  return offeredTargets(lead, targets).find((t) => sameLabel(t.label, lead.label) && !claimed.has(t.id)) ?? null;
}

/** The stored choice of one lead field for one target type. */
export function currentChoice(rows: MapRow[], leadFieldId: string, type: MapTarget): MapChoice {
  const row = rows.find((r) => r.leadFieldId === leadFieldId && r.targetType === type);
  if (!row) return AUTO;
  if (row.targetRemoved) return REMOVED;
  return row.mode === "field" && row.targetFieldId ? row.targetFieldId : row.mode === "none" ? NONE : AUTO;
}

/** The form input name of one choice. */
export function choiceName(type: MapTarget, leadFieldId: string): string {
  return `${type}:${leadFieldId}`;
}

export type MapPick = { leadFieldId: string; targetType: MapTarget; choice: MapChoice };

export type CheckResult = { ok: true } | { ok: false; reason: "invalid" | "duplicate" };

/**
 * Checks the picks of the form before they go to the database (which checks
 * them again). A picked field must be offered for that lead field, unless it is
 * the one already stored (a field hidden since stays as it is until someone
 * changes it). Two lead fields may not pick the same field.
 */
export function checkMapPicks(
  picks: MapPick[],
  rows: MapRow[],
  leadFields: MapField[],
  targetsByType: Record<MapTarget, MapField[]>,
): CheckResult {
  const finalTargets = new Map<string, string>();
  const seen = new Set<string>();
  for (const pick of picks) {
    const lead = leadFields.find((f) => f.id === pick.leadFieldId);
    const slot = `${pick.targetType}:${pick.leadFieldId}`;
    if (!lead || seen.has(slot)) return { ok: false, reason: "invalid" };
    seen.add(slot);
    const stored = currentChoice(rows, pick.leadFieldId, pick.targetType);
    if (pick.choice === REMOVED) {
      if (stored !== REMOVED) return { ok: false, reason: "invalid" };
      continue;
    }
    if (pick.choice === AUTO || pick.choice === NONE) continue;
    const offered = offeredTargets(lead, targetsByType[pick.targetType]).some((t) => t.id === pick.choice);
    if (!offered && pick.choice !== stored) return { ok: false, reason: "invalid" };
    const key = `${pick.targetType}:${pick.choice}`;
    if (finalTargets.has(key)) return { ok: false, reason: "duplicate" };
    finalTargets.set(key, pick.leadFieldId);
  }
  // a stored pick the form did not send still holds its field
  for (const row of rows) {
    if (row.mode !== "field" || !row.targetFieldId || seen.has(`${row.targetType}:${row.leadFieldId}`)) continue;
    const holder = finalTargets.get(`${row.targetType}:${row.targetFieldId}`);
    if (holder && holder !== row.leadFieldId) return { ok: false, reason: "duplicate" };
  }
  return { ok: true };
}

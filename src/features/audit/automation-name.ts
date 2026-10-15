import type { Json } from "@/lib/database.types";

/** Used only when an entry made by an automation carries no stored name. */
export const AUTOMATION_NAME_MISSING = "אוטומציה שנמחקה";

/**
 * PRM-01 (owner, 15 October 2026): the name app.audit_row stored with an automation's change, as the
 * rule was named at that moment. Never looked up again: renaming or deleting the rule changes nothing
 * here. null when no automation made the change.
 */
export function automationNameOf(changes: Json): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const rule = changes.automation;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return null;
  return typeof rule.name === "string" && rule.name.trim() !== "" ? rule.name : AUTOMATION_NAME_MISSING;
}

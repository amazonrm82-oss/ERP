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

/**
 * IMP-04 (owner (160) א): a change made by a background import or export carries the order's id, stamped by the
 * database from the worker's token of the person (trigger audit_log_background on public.audit_log). The entry's
 * actor is the person; this only says it went through a background job.
 */
export function viaBackgroundJob(changes: Json): boolean {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return false;
  const job = changes.background;
  return Boolean(job && typeof job === "object" && !Array.isArray(job) && typeof job.request_id === "string");
}

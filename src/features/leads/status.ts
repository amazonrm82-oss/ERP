import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database, LeadStatusKind } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

export type StatusResult = { ok: true } | { ok: false; message: string; needsReason?: boolean };

export type StatusChoice = { ok: true; reason: string | null } | { ok: false; message: string; needsReason?: boolean };

/**
 * The rules of a lead's status, shared by a status change and a new lead (RVW-9): the status must
 * still exist (kind null: it does not), "converted" is set only by the conversion, and "not relevant"
 * needs a reason, from the organization's active list when it keeps one (LEAD-03). The database
 * checks the same (trigger leads_disqualify_reason). Returns the reason to store: null for any
 * other status, so an old reason never stays behind.
 */
export function checkStatusChoice(kind: LeadStatusKind | null, reason: string | null, activeReasons: readonly string[]): StatusChoice {
  if (!kind) {
    return { ok: false, message: "הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב." };
  }
  if (kind === "converted") {
    return { ok: false, message: 'כדי לסמן ליד כ"הומר" יש להשתמש בכפתור ההמרה.' };
  }
  if (kind !== "disqualified") {
    return { ok: true, reason: null };
  }
  const trimmed = reason?.trim() || null;
  if (!trimmed) {
    return { ok: false, message: "יש לציין למה הליד לא רלוונטי.", needsReason: true };
  }
  if (activeReasons.length > 0 && !activeReasons.includes(trimmed)) {
    return { ok: false, message: "יש לבחור סיבה מהרשימה.", needsReason: true };
  }
  return { ok: true, reason: trimmed };
}

/**
 * Reads the status's kind (and, for "not relevant", the active reasons) and applies checkStatusChoice.
 */
export async function validateStatusChoice(
  supabase: SupabaseClient<Database>,
  orgId: string,
  statusId: string,
  reason: string | null,
): Promise<StatusChoice> {
  const { data: status, error: statusError } = await supabase.from("lead_statuses").select("id, kind").eq("organization_id", orgId).eq("id", statusId).maybeSingle();
  if (statusError) {
    return { ok: false, message: dbErrorMessage(statusError) };
  }
  let reasons: string[] = [];
  if (status?.kind === "disqualified") {
    const { data, error } = await supabase.from("disqualify_reasons").select("name").eq("organization_id", orgId).eq("is_active", true);
    if (error) {
      return { ok: false, message: dbErrorMessage(error) };
    }
    reasons = data.map((row) => row.name);
  }
  return checkStatusChoice(status?.kind ?? null, reason, reasons);
}

/** A status change from the status form and the leads board. */
export async function setLeadStatus(
  supabase: SupabaseClient<Database>,
  orgId: string,
  leadId: string,
  statusId: string,
  reason: string | null,
): Promise<StatusResult> {
  const choice = await validateStatusChoice(supabase, orgId, statusId, reason);
  if (!choice.ok) {
    return choice;
  }
  const { data, error } = await supabase
    .from("leads")
    .update({ status_id: statusId, disqualify_reason: choice.reason })
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .is("deleted_at", null)
    .select("id");
  if (error) {
    return { ok: false, message: dbErrorMessage(error, "לא הצלחנו לעדכן את הסטטוס. נסו שוב.") };
  }
  if (data.length === 0) {
    return { ok: false, message: NOT_FOUND_OR_FORBIDDEN };
  }
  return { ok: true };
}

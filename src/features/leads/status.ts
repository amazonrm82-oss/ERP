import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

export type StatusResult = { ok: true } | { ok: false; message: string; needsReason?: boolean };

/**
 * The rules of a status change, shared by the status form and the leads board:
 * the status must belong to the organization, "converted" is set only by the
 * conversion, and "not relevant" needs a reason, from the organization's list
 * when it keeps one (LEAD-03).
 */
export async function setLeadStatus(
  supabase: SupabaseClient<Database>,
  orgId: string,
  leadId: string,
  statusId: string,
  reason: string | null,
): Promise<StatusResult> {
  const { data: status, error: statusError } = await supabase.from("lead_statuses").select("id, kind").eq("organization_id", orgId).eq("id", statusId).maybeSingle();
  if (statusError) {
    return { ok: false, message: dbErrorMessage(statusError) };
  }
  if (!status) {
    return { ok: false, message: "הסטטוס שנבחר כבר לא קיים. רעננו את הדף ונסו שוב." };
  }
  if (status.kind === "converted") {
    return { ok: false, message: 'כדי לסמן ליד כ"הומר" יש להשתמש בכפתור ההמרה.' };
  }
  if (status.kind === "disqualified") {
    if (!reason) {
      return { ok: false, message: "יש לציין למה הליד לא רלוונטי.", needsReason: true };
    }
    // LEAD-03: once the organization keeps a list, the reason comes from it (the database checks it too)
    const { data: reasons, error: reasonsError } = await supabase.from("disqualify_reasons").select("name").eq("organization_id", orgId).eq("is_active", true);
    if (reasonsError) {
      return { ok: false, message: dbErrorMessage(reasonsError) };
    }
    if (reasons.length > 0 && !reasons.some((row) => row.name === reason)) {
      return { ok: false, message: "יש לבחור סיבה מהרשימה.", needsReason: true };
    }
  }
  const { data, error } = await supabase
    .from("leads")
    .update({ status_id: status.id, disqualify_reason: status.kind === "disqualified" ? reason : null })
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

import "server-only";

import { must } from "@/lib/db-read";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

import { parseInvitationEmailStatus, type InvitationEmailStatus } from "./email-status";

/**
 * USR-09: each pending invitation's latest email (public.invitation_email_status, owners and admins: ids, times and the
 * send's state only), for the users screen.
 */
export async function getInvitationEmailStatuses(orgId: string): Promise<Map<string, InvitationEmailStatus>> {
  const supabase = await createClient();
  const data = must(await supabase.rpc("invitation_email_status", { p_org: orgId }), "invitation_email_status");
  const out = new Map<string, InvitationEmailStatus>();
  if (!Array.isArray(data)) return out;
  for (const row of data) {
    const parsed = parseInvitationEmailStatus(row);
    if (parsed) out.set(parsed.invitationId, { state: parsed.state, composed: parsed.composed, whenText: formatDateTime(parsed.lastRequestedAt) });
  }
  return out;
}

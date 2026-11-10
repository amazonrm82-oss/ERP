"use server";

import { revalidatePath } from "next/cache";

import { metaLeadsSettingsPath } from "@/features/meta-leads/paths";
import { actionContext } from "@/lib/action-context";
import { fail, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";

import { connectionTestMessage } from "./test-messages";
import { integrationsSettingsPath } from "./paths";
import { runConnectionTest } from "./test-server";

/**
 * INT-01: tests a Meta page connection with its STORED token (owner, answer (227) ב). The person's own session is checked
 * first: an active owner or admin of the business who reads the connection under RLS (integrations_select); only then does
 * the server use the approved service-key path (test-server.ts), which checks the person again in the database. Nothing of
 * the token reaches the browser or the log.
 */
export async function testConnectionAction(orgId: string, integrationId: string): Promise<FormState> {
  const context = await actionContext(orgId, integrationId);
  if (!context.ok) return context;
  const { supabase } = context;
  const membership = await supabase
    .from("memberships")
    .select("role, status")
    .eq("organization_id", orgId)
    .eq("user_id", context.user.id);
  const me = membership.data?.[0];
  if (membership.error || !me || me.status !== "active" || (me.role !== "owner" && me.role !== "admin")) return fail(NOT_FOUND_OR_FORBIDDEN);
  const { data, error } = await supabase
    .from("integrations")
    .select("id, provider")
    .eq("organization_id", orgId)
    .eq("id", integrationId);
  if (error) return fail(dbErrorMessage(error));
  const row = data[0];
  if (!row || row.provider !== "meta_lead_ads") return fail(NOT_FOUND_OR_FORBIDDEN);

  const result = await runConnectionTest(orgId, integrationId, context.user.id);
  const message = connectionTestMessage(result.outcome, result.retrySeconds);
  revalidatePath(integrationsSettingsPath(orgId));
  revalidatePath(metaLeadsSettingsPath(orgId));
  return message.ok ? { ok: true, message: message.text } : fail(message.text);
}

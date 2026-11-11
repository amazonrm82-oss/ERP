"use server";

import { z } from "zod";

import { actionContext } from "@/lib/action-context";
import { fail, ok, type ActionResult } from "@/lib/action-result";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { dbErrorMessage } from "@/lib/errors";
import { siteOrigin } from "@/lib/site-origin";

import { PREFERENCE_CHANNELS, PREFERENCES_TOKEN, preferencesPagePath } from "./model";

const argSchema = z.object({
  kind: z.enum(["lead", "contact"]),
  id: z.guid(),
  channel: z.enum(PREFERENCE_CHANNELS),
});

const CANNOT = "רק בעלים ומנהלי מערכת יוצרים קישור להעדפות הדיוור, ורק כשהעסק פעיל.";

/**
 * CNS-10: an owner or admin copies a fresh preferences link for one channel of a lead or contact (for example to send it
 * by hand). It replaces the record's earlier link for that channel, which keeps only unsubscribing. RVW-82: a link copied
 * here only unsubscribes too; it never turns a channel back on (only the link a message carries does). The address is
 * shown once: only its hash is kept, and the audit log says that a link was made, never the link.
 */
export async function createPreferenceLinkAction(
  orgId: string,
  subject: { kind: "lead" | "contact"; id: string },
  channel: string,
): Promise<ActionResult<{ url: string }>> {
  const args = { ...subject, channel };
  if (!validArg(argSchema, args)) return fail(INVALID_ARGS);
  const context = await actionContext(orgId, args.id);
  if (!context.ok) return context;
  const { data, error } = await context.supabase.rpc("consent_preference_link_create", {
    p_org: orgId,
    p_kind: args.kind,
    p_id: args.id,
    p_channel: args.channel,
  });
  if (error) return fail(error.code === "42501" ? CANNOT : dbErrorMessage(error));
  if (typeof data !== "string" || !PREFERENCES_TOKEN.test(data)) return fail("לא הצלחנו ליצור קישור. נסו שוב.");
  return ok({ url: `${await siteOrigin()}${preferencesPagePath(data)}` });
}

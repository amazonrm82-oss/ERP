"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { cardFieldsErrorMessage } from "@/features/message-templates/card-fields";
import { quotePath } from "@/features/quotes/paths";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { actionContext } from "@/lib/action-context";
import { fail, type ActionResult } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";

import { QUOTE_MESSAGE_CHANNELS, queuedQuoteMessage } from "./logic";

/**
 * QUO-18: queues the quote's message with the user's session through public.quote_message_send, which reads the quote with
 * the user's rights and judges everything again (no service key). The queue's send check (consent, blocklist, pause, hours)
 * and the composer (the quote still on offer, the link minted last) judge it again when it is its turn.
 */
export async function sendQuoteMessageAction(orgId: string, quoteId: string, channel: string, templateId: string): Promise<ActionResult> {
  if (!validArg(z.enum(QUOTE_MESSAGE_CHANNELS), channel)) {
    return fail(INVALID_ARGS);
  }
  const context = await actionContext(orgId, quoteId, templateId);
  if (!context.ok) {
    return context;
  }
  const { data, error } = await context.supabase.rpc("quote_message_send", { p_org: orgId, p_quote: quoteId, p_channel: channel, p_template: templateId });
  if (error) {
    return fail(cardFieldsErrorMessage(error) ?? dbErrorMessage(error, "לא הצלחנו לשלוח את ההצעה. נסו שוב."));
  }
  const paused = Boolean(data && typeof data === "object" && !Array.isArray(data) && (data as Record<string, unknown>).paused === true);
  revalidatePath(quotePath(orgId, quoteId));
  return { ok: true, message: queuedQuoteMessage(channel, paused) };
}

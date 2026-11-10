"use server";

import { z } from "zod";

import { duplicateMessage, findPersonDuplicate } from "@/features/data-quality/duplicates";
import { actionContext } from "@/lib/action-context";
import { INVALID_ARGS, validArg } from "@/lib/action-args";
import { fail, ok, type ActionResult } from "@/lib/action-result";

import { duplicateLookupInput } from "./form-memory";

const textArg = z.string().max(400);

export type TypingDuplicate = { message: string; href: string };

/**
 * UX-03: the DQL-02 duplicate check while the new-lead form is being typed. Reads with the user's session
 * (only records the user can see are pointed out) and answers a warning to show, never a refusal: saving
 * still decides on its own.
 */
export async function checkLeadDuplicateAction(orgId: string, phone: unknown, email: unknown): Promise<ActionResult<TypingDuplicate | null>> {
  const context = await actionContext(orgId);
  if (!context.ok) {
    return context;
  }
  if (!validArg(textArg, phone) || !validArg(textArg, email)) {
    return fail(INVALID_ARGS);
  }
  const input = duplicateLookupInput(phone, email);
  if (!input) {
    return ok(null);
  }
  try {
    const found = await findPersonDuplicate(context.supabase, orgId, [input.phone], [input.email]);
    if (!found) {
      return ok(null);
    }
    const what = input.phone && input.email ? "הטלפון או האימייל האלה" : input.phone ? "הטלפון הזה" : "האימייל הזה";
    return ok({ message: duplicateMessage(found, what), href: found.href });
  } catch {
    // a failed read shows nothing while typing; the save runs the check again
    return ok(null);
  }
}

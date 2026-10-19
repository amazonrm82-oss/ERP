"use server";

import { revalidatePath } from "next/cache";

import type { WonTarget } from "@/features/deals/components/deal-won-dialog";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, ok, type ActionResult, type FormState } from "@/lib/action-result";
import { dbErrorMessage, NOT_FOUND_OR_FORBIDDEN } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

import { QUOTE_ACCEPT_DEAL_FIELD_NAMES, quoteAcceptDealSchema, quoteAmountHint } from "./accept-deal";
import { quoteDesignPath } from "./paths";

const NOT_ADMIN = "רק בעלים ומנהלי מערכת יכולים לשנות את ההגדרה.";

/**
 * QUO-13: what an accepted quote does to its deal. Saved on the business's one documents-settings row with the user's
 * session: updated first, inserted only when there is none, and updated once more when the insert lost a race (no upsert:
 * its DO UPDATE names organization_id, which has no UPDATE grant).
 */
export async function saveQuoteAcceptDealAction(orgId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId);
  if (!context.ok) return context;
  const parsed = quoteAcceptDealSchema.safeParse(pick(formData, QUOTE_ACCEPT_DEAL_FIELD_NAMES));
  if (!parsed.success) return invalid(parsed.error, formData);
  const values = { values: formValues(formData) };
  const table = () => context.supabase.from("org_document_settings");
  const update = () => table().update(parsed.data).eq("organization_id", orgId).select("id");
  let result = await update();
  if (!result.error && result.data.length === 0) {
    const inserted = await table()
      .insert({ organization_id: orgId, ...parsed.data })
      .select("id");
    result = inserted.error?.code === "23505" ? await update() : inserted;
  }
  if (result.error) return fail(result.error.code === "42501" ? NOT_ADMIN : dbErrorMessage(result.error), values);
  if (result.data.length === 0) return fail(NOT_ADMIN, values);
  revalidatePath(quoteDesignPath(orgId));
  return { ok: true, message: "ההגדרה נשמרה. היא חלה על כל הצעה שתאושר מעכשיו." };
}

/**
 * QUO-13, the "ask" flow on the quote page: the won window's target for the quote's deal (its first won stage). Reads only:
 * the lines are replaced when the window is confirmed, together with the move (closeQuoteDealWonAction, public.quote_win_deal).
 */
export async function quoteDealMoveTargetAction(orgId: string, quoteId: string): Promise<ActionResult<WonTarget>> {
  const context = await actionContext(orgId, quoteId);
  if (!context.ok) return context;
  const { supabase } = context;
  const quote = await supabase
    .from("quotes")
    .select("deal_id, status, net_total_agorot, number_display")
    .eq("organization_id", orgId)
    .eq("id", quoteId)
    .maybeSingle();
  if (quote.error) return fail(dbErrorMessage(quote.error));
  const dealId = quote.data?.deal_id;
  if (!dealId || quote.data?.status !== "accepted") return fail("להצעה הזו אין עסקה פתוחה לעדכן.");
  const deal = await supabase
    .from("deals")
    .select("id, name, pipeline_id, amount_agorot, owner_id, status, deleted_at")
    .eq("organization_id", orgId)
    .eq("id", dealId)
    .maybeSingle();
  if (deal.error) return fail(dbErrorMessage(deal.error));
  if (!deal.data) return fail(NOT_FOUND_OR_FORBIDDEN);
  if (deal.data.status !== "open" || deal.data.deleted_at !== null) return fail("העסקה כבר סגורה או בסל המחזור.");
  const stage = await supabase
    .from("stages")
    .select("id, name")
    .eq("organization_id", orgId)
    .eq("pipeline_id", deal.data.pipeline_id)
    .eq("kind", "won")
    .order("position")
    .order("id")
    .limit(1)
    .maybeSingle();
  if (stage.error) return fail(dbErrorMessage(stage.error));
  if (!stage.data) return fail("בתהליך המכירה של העסקה אין שלב זכייה.");
  revalidatePath(paths.deal(orgId, dealId));
  return ok({
    dealId,
    dealName: deal.data.name,
    stageId: stage.data.id,
    stageName: stage.data.name,
    // QUO-13 (owner, 19 October 2026): the deal's amount is the quote's total before VAT, after its document discount
    amountAgorot: quote.data.net_total_agorot,
    amountHint: quoteAmountHint(quote.data.number_display),
    ownerId: deal.data.owner_id,
  });
}

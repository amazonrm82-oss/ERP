"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { productPath, productsPath } from "@/features/products/paths";
import { PRICE_MAX_AGOROT } from "@/features/products/schema";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { parseMoneyToAgorot } from "@/lib/format";
import { paths } from "@/lib/paths";
import { pick } from "@/lib/validation";

// PRD-06: the cost of a product is written with the user's session; RLS lets only someone who both
// sees costs and edits the catalog write it (product_costs policies), in a writable business.

const NOT_ALLOWED = "אין לך הרשאה לשנות את העלות של המוצר.";

const costSchema = z.object({
  cost: z.preprocess(
    (value) => (typeof value === "string" ? value.trim() : ""),
    z
      .string()
      .transform((value, ctx) => {
        if (value === "") return null;
        const agorot = parseMoneyToAgorot(value);
        if (agorot === null) {
          ctx.addIssue({ code: "custom", message: "יש להזין סכום בשקלים, למשל 12.50." });
          return z.NEVER;
        }
        if (agorot > PRICE_MAX_AGOROT) {
          ctx.addIssue({ code: "custom", message: "העלות גבוהה מדי." });
          return z.NEVER;
        }
        return agorot;
      }),
  ),
});

/** Sets the product's cost per unit, or removes it when the field is empty. */
export async function setProductCostAction(orgId: string, productId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, productId);
  if (!context.ok) return context;
  const parsed = costSchema.safeParse(pick(formData, ["cost"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const cost = parsed.data.cost;
  const { supabase } = context;
  const done = (message: string) => {
    revalidatePath(productsPath(orgId));
    revalidatePath(productPath(orgId, productId));
    return { ok: true as const, message };
  };

  if (cost === null) {
    const { data, error } = await supabase.from("product_costs").delete().eq("organization_id", orgId).eq("product_id", productId).select("id");
    if (error) return fail(dbErrorMessage(error), { values: formValues(formData) });
    return done(data.length > 0 ? "העלות הוסרה." : "למוצר אין עלות שמורה.");
  }

  // update first (the insert's unique key is the product), then insert; a parallel insert is retried as an update
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabase
      .from("product_costs")
      .update({ cost_agorot: cost })
      .eq("organization_id", orgId)
      .eq("product_id", productId)
      .select("id");
    if (error) return fail(dbErrorMessage(error), { values: formValues(formData) });
    if (data.length > 0) return done("העלות נשמרה.");
    const { error: insertError } = await supabase
      .from("product_costs")
      .insert({ organization_id: orgId, product_id: productId, cost_agorot: cost })
      .select("id")
      .single();
    if (!insertError) return done("העלות נשמרה.");
    if (insertError.code === "23505") continue;
    if (insertError.code === "42501") return fail(NOT_ALLOWED, { values: formValues(formData) });
    if (insertError.code === "23503") return fail("המוצר כבר לא קיים.", { values: formValues(formData) });
    return fail(dbErrorMessage(insertError), { values: formValues(formData) });
  }
  return fail("לא הצלחנו לשמור. נסו שוב.", { values: formValues(formData) });
}

const LINE_NOT_ALLOWED = "אי אפשר לשנות את העלות של השורה: העסקה סגורה, או שאין לך הרשאה.";

/**
 * PRD-06 follow-up: the cost per unit kept on a deal line (owner, 15 October 2026): those who see costs change it while
 * the deal is open; an empty field removes it. RLS on deal_line_costs decides (0 rows = closed deal or not allowed).
 */
export async function setDealLineCostAction(orgId: string, dealId: string, lineId: string, _prev: FormState, formData: FormData): Promise<FormState> {
  const context = await actionContext(orgId, dealId, lineId);
  if (!context.ok) return context;
  const parsed = costSchema.safeParse(pick(formData, ["cost"]));
  if (!parsed.success) return invalid(parsed.error, formData);
  const cost = parsed.data.cost;
  const { supabase } = context;
  const values = formValues(formData);
  const done = (message: string) => {
    revalidatePath(paths.deal(orgId, dealId));
    return { ok: true as const, message };
  };

  if (cost === null) {
    const { data, error } = await supabase.from("deal_line_costs").delete().eq("organization_id", orgId).eq("deal_line_id", lineId).select("id");
    if (error) return fail(dbErrorMessage(error), { values });
    return done(data.length > 0 ? "העלות של השורה הוסרה." : "לשורה אין עלות שמורה.");
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { data, error } = await supabase
      .from("deal_line_costs")
      .update({ cost_agorot: cost })
      .eq("organization_id", orgId)
      .eq("deal_line_id", lineId)
      .select("id");
    if (error) return fail(dbErrorMessage(error), { values });
    if (data.length > 0) return done("העלות של השורה נשמרה.");
    const { error: insertError } = await supabase
      .from("deal_line_costs")
      .insert({ organization_id: orgId, deal_line_id: lineId, cost_agorot: cost })
      .select("id")
      .single();
    if (!insertError) return done("העלות של השורה נשמרה.");
    if (insertError.code === "23505") {
      // the row exists but this user could not update it: a closed deal or no right, not a race
      if (attempt === 1) return fail(LINE_NOT_ALLOWED, { values });
      continue;
    }
    if (insertError.code === "42501") return fail(LINE_NOT_ALLOWED, { values });
    if (insertError.code === "23503") return fail("השורה כבר לא קיימת.", { values });
    return fail(dbErrorMessage(insertError), { values });
  }
  return fail(LINE_NOT_ALLOWED, { values });
}

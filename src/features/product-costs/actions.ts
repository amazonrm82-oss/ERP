"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { productPath, productsPath } from "@/features/products/paths";
import { PRICE_MAX_AGOROT } from "@/features/products/schema";
import { actionContext } from "@/lib/action-context";
import { fail, formValues, invalid, type FormState } from "@/lib/action-result";
import { dbErrorMessage } from "@/lib/errors";
import { parseMoneyToAgorot } from "@/lib/format";
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

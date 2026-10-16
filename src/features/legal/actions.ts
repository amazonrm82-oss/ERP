"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { fail, formValues, type FormState } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { dbErrorMessage } from "@/lib/errors";

import { safeNextPath } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { AGREEMENT_VERSION, agreementSnapshot } from "./agreement";

const schema = z.object({
  full_name: z.string().trim().min(2, "יש לכתוב שם מלא.").max(120),
  method: z.enum(["drawn", "typed"]),
  // a drawn signature: a PNG from the signature pad, at most ~300KB
  signature: z.string().max(400_000).optional(),
});

/** Signs the current terms, privacy policy and data processing agreement, then continues. */
export async function signAgreementAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await sessionCheck();
  if (!session.ok) return fail(session.message);
  const parsed = schema.safeParse({
    full_name: formData.get("full_name"),
    method: formData.get("method"),
    signature: formData.get("signature") || undefined,
  });
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "הפרטים אינם תקינים.", { values: formValues(formData) });
  if (formData.get("agree") !== "on") return fail("יש לסמן שקראתם ואתם מסכימים.", { values: formValues(formData) });
  const { full_name, method, signature } = parsed.data;
  if (method === "drawn" && !signature?.startsWith("data:image/png;base64,")) {
    return fail("יש לחתום בתיבת החתימה, או לבחור \"הקלדת שם\".", { values: formValues(formData) });
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("sign_agreement", {
    p_version: AGREEMENT_VERSION,
    p_documents: agreementSnapshot(),
    p_full_name: full_name,
    p_method: method,
    p_signature: method === "drawn" ? (signature ?? null) : null,
  });
  // FXS-09: a text the database does not know for this version (a deploy and its migration out of step) says so
  if (error) return fail(dbErrorMessage(error, "לא הצלחנו לשמור את החתימה. נסו שוב."), { values: formValues(formData) });
  redirect(safeNextPath(formData.get("next")?.toString()));
}

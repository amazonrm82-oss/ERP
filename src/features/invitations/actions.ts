"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fail, type FormState } from "@/lib/action-result";
import { sessionCheck } from "@/lib/auth";
import { dbErrorMessage } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { isInvitationToken } from "./token";

/** Joins the organization of the invitation. The database checks the token, expiry and email address. */
export async function acceptInvitationAction(token: string): Promise<FormState> {
  if (!isInvitationToken(token)) {
    return fail("ההזמנה אינה בתוקף. בקשו ממי שהזמין אתכם לשלוח הזמנה חדשה.");
  }
  const session = await sessionCheck();
  if (!session.ok) {
    return fail(session.message);
  }
  const supabase = await createClient();
  const { data: orgId, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error || !orgId) {
    return fail(dbErrorMessage(error, "לא הצלחנו לצרף אתכם לעסק. נסו שוב."));
  }
  revalidatePath("/", "layout");
  redirect(paths.org(orgId));
}

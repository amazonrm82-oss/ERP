"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { fail, type FormState } from "@/lib/action-result";
import { getSessionUser } from "@/lib/auth";
import { dbErrorMessage, SESSION_EXPIRED } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

import { isInvitationToken } from "./token";

/** Joins the organization of the invitation. The database checks the token, expiry and email address. */
export async function acceptInvitationAction(token: string): Promise<FormState> {
  if (!isInvitationToken(token)) {
    return fail("ההזמנה אינה בתוקף. בקשו ממי שהזמין אתכם לשלוח הזמנה חדשה.");
  }
  const user = await getSessionUser();
  if (!user) {
    return fail(SESSION_EXPIRED);
  }
  const supabase = await createClient();
  const { data: orgId, error } = await supabase.rpc("accept_invitation", { p_token: token });
  if (error || !orgId) {
    return fail(dbErrorMessage(error, "לא הצלחנו לצרף אתכם לעסק. נסו שוב."));
  }
  revalidatePath("/", "layout");
  redirect(paths.org(orgId));
}

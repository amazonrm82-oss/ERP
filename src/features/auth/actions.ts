"use server";

import { redirect } from "next/navigation";

import { fail, invalid, formValues, type FormState } from "@/lib/action-result";
import { authErrorMessage } from "@/lib/errors";
import { paths, safeNextPath } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";
import { createClient } from "@/lib/supabase/server";
import { pick } from "@/lib/validation";

import { signInSchema, signUpSchema } from "./schema";

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse(pick(formData, ["email", "password"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return fail(authErrorMessage(error, "לא הצלחנו לחבר אותך. נסו שוב."), { values: formValues(formData) });
  }

  redirect(safeNextPath(formData.get("next")?.toString()));
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse(pick(formData, ["full_name", "email", "password"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // where to continue after confirming, e.g. an invitation link
  const next = safeNextPath(formData.get("next")?.toString());
  const callback = next === "/" ? "/auth/callback" : `/auth/callback?next=${encodeURIComponent(next)}`;

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // copied to profiles.full_name by the handle_new_user trigger
      data: { full_name: parsed.data.full_name },
      emailRedirectTo: `${await siteOrigin()}${callback}`,
    },
  });
  if (error) {
    return fail(authErrorMessage(error, "לא הצלחנו ליצור את החשבון. נסו שוב."), { values: formValues(formData) });
  }

  // With email confirmation on, Supabase answers a sign-up for an address that
  // already has an account with a user that has no identities (and sends nothing).
  if (data.user && data.user.identities && data.user.identities.length === 0) {
    return fail("כבר קיים חשבון עם כתובת האימייל הזו. אפשר להתחבר.", { values: formValues(formData) });
  }

  if (data.session) {
    // email confirmation is off: the user is already signed in
    redirect(next === "/" ? paths.onboarding : next);
  }

  return {
    ok: true,
    message: `שלחנו הודעת אימות אל ${parsed.data.email}. לחצו על הקישור שבה כדי להמשיך.`,
  };
}

export async function signOutAction(): Promise<void> {
  const supabase = await createClient();
  // "local": ends this browser's session only, other devices stay signed in
  await supabase.auth.signOut({ scope: "local" });
  redirect(paths.login);
}

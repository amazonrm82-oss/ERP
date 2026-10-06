"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { fail, invalid, formValues, type FormState } from "@/lib/action-result";
import { authErrorMessage } from "@/lib/errors";
import { paths, safeNextPath } from "@/lib/paths";
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

// Where the confirmation email sends the user back to. NEXT_PUBLIC_SITE_URL
// wins when set; otherwise the origin of this request. Supabase only honours
// URLs on the project's redirect allow-list, so a forged Host header cannot
// redirect a confirmation link to another site.
async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, "");
  if (configured) {
    return configured;
  }
  const headerList = await headers();
  const origin = headerList.get("origin");
  if (origin) {
    return origin;
  }
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "localhost:3000";
  const protocol = headerList.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${protocol}://${host}`;
}

export async function signUpAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signUpSchema.safeParse(pick(formData, ["full_name", "email", "password"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      // copied to profiles.full_name by the handle_new_user trigger
      data: { full_name: parsed.data.full_name },
      emailRedirectTo: `${await siteOrigin()}/auth/callback`,
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
    redirect(paths.onboarding);
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

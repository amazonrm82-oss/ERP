"use server";

import { redirect } from "next/navigation";

import { LEGAL_VERSION } from "@/features/legal/documents";
import { fail, invalid, formValues, type FormState } from "@/lib/action-result";
import { getSessionUser, owesSecondStep } from "@/lib/auth";
import { authErrorMessage, SESSION_EXPIRED } from "@/lib/errors";
import { paths, safeNextPath } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";
import { createClient } from "@/lib/supabase/server";
import { pick } from "@/lib/validation";

import { forgotPasswordSchema, newPasswordSchema, signInSchema, signUpSchema } from "./schema";

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

  const next = safeNextPath(formData.get("next")?.toString());
  // a verified authenticator on the account: the code comes next
  if (await owesSecondStep()) {
    redirect(`${paths.loginMfa}?next=${encodeURIComponent(next)}`);
  }
  redirect(next);
}

/** Sends a reset link. Answers the same whether or not the address has an account. */
export async function forgotPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = forgotPasswordSchema.safeParse(pick(formData, ["email"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${await siteOrigin()}/auth/callback?next=${encodeURIComponent(paths.resetPassword)}`,
  });
  // rate limits are worth telling; "no such user" is not (it would reveal who has an account)
  if (error && error.status === 429) {
    return fail(authErrorMessage(error, "נשלחו יותר מדי בקשות. נסו שוב בעוד כמה דקות."), { values: formValues(formData) });
  }
  return { ok: true, message: `אם יש חשבון עם הכתובת ${parsed.data.email}, שלחנו אליה קישור לבחירת סיסמה חדשה.` };
}

/** New password for the signed-in user (after a reset link, or from the account page). */
export async function setPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = newPasswordSchema.safeParse({ password: formData.get("password"), confirm: formData.get("confirm") });
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return fail(authErrorMessage(error, "לא הצלחנו לשמור את הסיסמה. נסו שוב."));
  }
  return { ok: true, message: "הסיסמה עודכנה." };
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
      // full_name is copied to profiles.full_name by the handle_new_user trigger;
      // terms_* record which version of the terms the user agreed to by signing up
      data: { full_name: parsed.data.full_name, terms_version: LEGAL_VERSION, terms_accepted_at: new Date().toISOString() },
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

export type RecoverResult = { ok: true; needsSetup: boolean } | { ok: false; message: string };

/**
 * Signs in with a backup code instead of the authenticator app: the database checks
 * the code and removes the lost authenticator. Every other device is signed out, in
 * case the password is what leaked. `needsSetup`: an organization requires two-step
 * verification, so a new authenticator must be set up right away.
 */
export async function recoverWithCodeAction(code: string): Promise<RecoverResult> {
  if (!(await getSessionUser())) return fail(SESSION_EXPIRED);
  if (typeof code !== "string" || code.replace(/[^0-9a-f]/gi, "").length !== 12) {
    return fail("קוד גיבוי הוא 12 תווים, למשל 1a2b-3c4d-5e6f.");
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("mfa_recover", { p_code: code });
  if (error) return fail("לא הצלחנו לבדוק את הקוד. נסו שוב.");
  const result = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  if (result.ok !== true) {
    if (result.reason === "too_many") return fail("יותר מדי ניסיונות. נסו שוב בעוד רבע שעה.");
    if (result.reason === "no_factor") return fail("אימות דו-שלבי כבר לא פעיל בחשבון. רעננו את הדף.");
    return fail("הקוד לא נכון, או שכבר השתמשו בו.");
  }
  await supabase.auth.signOut({ scope: "others" });
  const { data: required, error: requiredError } = await supabase.rpc("mfa_required_orgs");
  // when unsure, send them to the set-up page, which checks again
  return { ok: true, needsSetup: Boolean(requiredError) || (Array.isArray(required) && required.length > 0) };
}

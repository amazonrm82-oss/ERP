"use server";

import { redirect } from "next/navigation";

import { LEGAL_VERSION } from "@/features/legal/documents";
import { fail, invalid, formValues, type FormState } from "@/lib/action-result";
import { owesSecondStep, sessionCheck } from "@/lib/auth";
import { authErrorMessage } from "@/lib/errors";
import { paths, safeNextPath } from "@/lib/paths";
import { siteOrigin } from "@/lib/site-origin";
import { forwardedResetPassword, forwardedSignIn, forwardedSignUp } from "@/lib/supabase/auth-forwarding-server";
import { createClient } from "@/lib/supabase/server";
import { pick } from "@/lib/validation";
import { validArg } from "@/lib/action-args";
import { z } from "zod";

import { isInvalidCredentials, recordLoginOutcome, reserveLoginAttempt } from "./login-guard-server";
import { forgotPasswordSchema, newPasswordSchema, signInSchema, signUpSchema } from "./schema";
import { TURNSTILE_ACTIONS } from "./turnstile";
import { verifyTurnstile, verifyTurnstileToken } from "./turnstile-server";

/** The one answer for a wrong address or password, and for a locked one (never tells which, or whether the address exists). */
const WRONG_CREDENTIALS = authErrorMessage({ code: "invalid_credentials" });

export async function signInAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse(pick(formData, ["email", "password"]));
  if (!parsed.success) {
    return invalid(parsed.error, formData);
  }

  // owner (275) א: Turnstile is checked by our server before any Auth call (with the secret key Auth skips its own CAPTCHA)
  const captcha = await verifyTurnstile(formData, TURNSTILE_ACTIONS.signIn);
  if (!captcha.ok) return fail(captcha.message, { values: formValues(formData) });

  // USR-13 (owner (364) א, (370) א): one try is reserved before Auth; a locked address or sender gets EXACTLY the
  // wrong-password answer, and Auth is not asked
  const reservation = await reserveLoginAttempt(parsed.data.email);
  if (reservation.locked) {
    return fail(WRONG_CREDENTIALS, { values: formValues(formData) });
  }

  // FXS-12: the user's address goes to Auth's rate limit (else the user's own client, as before)
  let answer: Awaited<ReturnType<typeof forwardedSignIn>>;
  try {
    answer = await forwardedSignIn(parsed.data);
  } catch (thrown) {
    // Auth was not reached or did not answer: the reserved try is given back
    await recordLoginOutcome(parsed.data.email, "release", reservation);
    throw thrown;
  }
  const { error } = answer;
  if (error) {
    // only Auth's own "wrong address or password" keeps the reserved try; a network error, a 5xx or a rate limit gives it back
    if (isInvalidCredentials(error)) {
      return fail(WRONG_CREDENTIALS, { values: formValues(formData) });
    }
    await recordLoginOutcome(parsed.data.email, "release", reservation);
    return fail(authErrorMessage(error, "לא הצלחנו לחבר אתכם. נסו שוב."), { values: formValues(formData) });
  }
  await recordLoginOutcome(parsed.data.email, "success", reservation);

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
  const captcha = await verifyTurnstile(formData, TURNSTILE_ACTIONS.forgotPassword);
  if (!captcha.ok) return fail(captcha.message, { values: formValues(formData) });
  const { error } = await forwardedResetPassword(parsed.data.email, {
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

  const captcha = await verifyTurnstile(formData, TURNSTILE_ACTIONS.signUp);
  if (!captcha.ok) return fail(captcha.message, { values: formValues(formData) });

  const { data, error } = await forwardedSignUp({
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

const resendArgs = z.object({ email: z.email().max(254), next: z.string().max(500) });

/** Sends the confirmation email again, to the address just signed up with (FXU-05). */
export async function resendConfirmationAction(email: string, next: string, turnstileToken?: string | null): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!validArg(resendArgs, { email, next })) return fail("כתובת האימייל אינה תקינה.");
  // owner (275) א, (319) א: checked like sign-up, before the Auth call
  const captcha = await verifyTurnstileToken(turnstileToken, TURNSTILE_ACTIONS.resend);
  if (!captcha.ok) return fail(captcha.message);
  const target = safeNextPath(next);
  const callback = target === "/" ? "/auth/callback" : `/auth/callback?next=${encodeURIComponent(target)}`;
  const supabase = await createClient();
  const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: `${await siteOrigin()}${callback}` } });
  if (error) {
    return fail(authErrorMessage(error, "לא הצלחנו לשלוח שוב. נסו בעוד דקה."));
  }
  return { ok: true };
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
  const session = await sessionCheck();
  if (!session.ok) return fail(session.message);
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

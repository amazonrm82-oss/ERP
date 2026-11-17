import { carriedSource, isNewSignupAccount, LANDING_SOURCE_PARAM, SIGNUP_PLAN_PARAM, signupPlanKey } from "@/features/landing/measure";

// WEB-02 answer (403) ב: the price card's plan and the folded landing source also travel through sign-up with Google. They ride
// in the OAuth callback's own query (never a cookie, never a visitor id), and the callback writes them into the person's OWN Auth
// metadata with their own session, for a brand-new account only and never over a value already there. Nothing is trusted:
// public.create_organization honours the plan only while it is available and folds the source again.

/** The keys the sign-up metadata uses (the email sign-up writes the same two, src/features/auth/actions.ts). */
export const SIGNUP_META_PLAN = "signup_plan";
export const SIGNUP_META_SOURCE = "signup_source";

const isInvitation = (next: string) => next.startsWith("/invite/");

/**
 * The OAuth callback's path and query: `next` as before (left out when it is "/"), and, never for an invitation, a well-formed
 * folded source and plan key. Anything malformed is dropped.
 */
export function oauthCallbackPath(next: string, source: string | null = null, plan: string | null = null): string {
  const params = new URLSearchParams();
  if (next !== "/") params.set("next", next);
  if (!isInvitation(next)) {
    const src = carriedSource(source);
    const key = signupPlanKey(plan);
    if (src) params.set(LANDING_SOURCE_PARAM, src);
    if (key) params.set(SIGNUP_PLAN_PARAM, key);
  }
  const query = params.toString();
  return query ? `/auth/callback?${query}` : "/auth/callback";
}

type CallbackUser = {
  created_at?: string | null;
  identities?: unknown[] | null;
  user_metadata?: Record<string, unknown> | null;
} | null | undefined;

/**
 * What the callback writes into the signed-in person's own metadata, or null for nothing: only for a brand-new account
 * (isNewSignupAccount, LND-14's rule: made by Auth within the last minute, with an identity), never for an invitation, only
 * well-formed values, and never a key the metadata already holds.
 */
export function oauthSignupMetadata(
  params: { next: string; source: string | null; plan: string | null },
  user: CallbackUser,
  now: Date = new Date(),
): Record<string, string> | null {
  if (isInvitation(params.next) || !user || !isNewSignupAccount(user, now)) return null;
  const meta = user.user_metadata ?? {};
  const data: Record<string, string> = {};
  const key = signupPlanKey(params.plan);
  const src = carriedSource(params.source);
  if (key && !(SIGNUP_META_PLAN in meta)) data[SIGNUP_META_PLAN] = key;
  if (src && !(SIGNUP_META_SOURCE in meta)) data[SIGNUP_META_SOURCE] = src;
  return Object.keys(data).length > 0 ? data : null;
}

/**
 * WEB-02 answer (405) א: the folded landing source a Google sign-up is counted under as an LND-14 "signup", or null for no
 * count. The same rule as the email sign-up action: a brand-new account (isNewSignupAccount) carrying a well-formed source,
 * never an invitation.
 */
export function oauthSignupCountedSource(
  params: { next: string; source: string | null },
  user: CallbackUser,
  now: Date = new Date(),
): string | null {
  if (isInvitation(params.next) || !user || !isNewSignupAccount(user, now)) return null;
  return carriedSource(params.source);
}

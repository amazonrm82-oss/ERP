import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { getSupabaseEnv } from "@/lib/env";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";

export type SessionUser = {
  id: string;
  email: string | null;
  fullName: string | null;
};

// The verified user of this request, or null. getClaims() validates the JWT
// signature (locally with asymmetric keys, otherwise by asking the Auth
// server), unlike getSession() which trusts the cookie.
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  if (!getSupabaseEnv()) {
    // Not configured: nobody can be signed in. Pages then redirect to /login,
    // where the root layout shows the "missing configuration" screen.
    await cookies(); // keep callers request-time, so this is never baked into a prerender
    return null;
  }
  const supabase = await createClient();
  let claims;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error || !data?.claims?.sub) {
      return null;
    }
    claims = data.claims;
  } catch {
    // Auth server unreachable: treat as signed out rather than crash the page.
    return null;
  }
  const fullName = claims.user_metadata?.full_name;
  return {
    id: claims.sub,
    email: typeof claims.email === "string" ? claims.email : null,
    fullName: typeof fullName === "string" && fullName.trim() !== "" ? fullName.trim() : null,
  };
});

/** For pages: the signed-in user, or a redirect to the login page. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(paths.login);
  }
  return user;
}

/** Whether this session still owes the two-step code (the account has an authenticator, the session did not pass it). */
export async function owesSecondStep(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("mfa_status");
  const status = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return status.enrolled === true && status.aal !== "aal2";
}

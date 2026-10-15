import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { AUTH_UNAVAILABLE_MESSAGE, AuthUnavailableError } from "@/lib/auth-unavailable";
import { isTransientAuthError, logSessionCheckThrow } from "@/lib/auth-transient";
import { getSupabaseEnv } from "@/lib/env";
import { SESSION_EXPIRED } from "@/lib/errors";
import { paths } from "@/lib/paths";
import { createClient } from "@/lib/supabase/server";
import { must } from "@/lib/db-read";

export type SessionUser = {
  id: string;
  email: string | null;
  fullName: string | null;
};

type SessionRead = { kind: "user"; user: SessionUser } | { kind: "none" } | { kind: "unavailable" };

// The verified user of this request. getClaims() validates the JWT signature (locally with asymmetric keys, otherwise
// by asking the Auth server), unlike getSession() which trusts the cookie. FXC-10: when the Auth server does not answer
// (network, 5xx, rate limit) the answer is "unavailable", never "signed out".
const readSession = cache(async (): Promise<SessionRead> => {
  if (!getSupabaseEnv()) {
    // Not configured: nobody can be signed in. Pages then redirect to /login,
    // where the root layout shows the "missing configuration" screen.
    await cookies(); // keep callers request-time, so this is never baked into a prerender
    return { kind: "none" };
  }
  const supabase = await createClient();
  let claims;
  try {
    const { data, error } = await supabase.auth.getClaims();
    if (error) {
      return isTransientAuthError(error) ? { kind: "unavailable" } : { kind: "none" };
    }
    if (!data?.claims?.sub) {
      return { kind: "none" };
    }
    claims = data.claims;
  } catch (error) {
    // something other than an answer about the session (a network failure that escaped auth-js, or a bug)
    logSessionCheckThrow("readSession", error);
    return { kind: "unavailable" };
  }
  const fullName = claims.user_metadata?.full_name;
  return {
    kind: "user",
    user: {
      id: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
      fullName: typeof fullName === "string" && fullName.trim() !== "" ? fullName.trim() : null,
    },
  };
});

/**
 * The verified user of this request, or null when signed out. Throws AuthUnavailableError when the session cannot be
 * checked right now (FXC-10): pages show "communication problem" with a retry instead of sending the user to log in.
 * Server Actions and route handlers use sessionCheck(), which answers with a message instead of throwing.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const session = await readSession();
  if (session.kind === "unavailable") {
    throw new AuthUnavailableError();
  }
  return session.kind === "user" ? session.user : null;
}

/** For Server Actions and route handlers: the user, or why not (signed out, or the sign-in service did not answer). */
export async function sessionCheck(): Promise<{ ok: true; user: SessionUser } | { ok: false; message: string; unavailable: boolean }> {
  const session = await readSession();
  if (session.kind === "user") {
    return { ok: true, user: session.user };
  }
  return session.kind === "unavailable"
    ? { ok: false, message: AUTH_UNAVAILABLE_MESSAGE, unavailable: true }
    : { ok: false, message: SESSION_EXPIRED, unavailable: false };
}

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
  const data = must(await supabase.rpc("mfa_status"), "mfa_status");
  const status = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return status.enrolled === true && status.aal !== "aal2";
}

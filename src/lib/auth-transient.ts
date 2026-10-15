import { AuthUnknownError, isAuthError, isAuthRetryableFetchError } from "@supabase/supabase-js";

/**
 * FXC-10: whether a failed session check is a passing problem with the sign-in service rather than an answer about the
 * session. A network error or a 5xx (auth-js: AuthRetryableFetchError), a reply that could not be read
 * (AuthUnknownError), a rate limit (429), or anything thrown that is not an auth error at all. An answer such as "no
 * session", "invalid token" or "user not found" is not transient: that user is signed out.
 */
export function isTransientAuthError(error: unknown): boolean {
  if (!isAuthError(error)) {
    return true;
  }
  if (isAuthRetryableFetchError(error) || error instanceof AuthUnknownError) {
    return true;
  }
  return error.status === 429;
}

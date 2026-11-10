import { AuthUnknownError, isAuthError, isAuthRetryableFetchError } from "@supabase/supabase-js";

import { errorFields, logEvent } from "@/lib/log";

export { redactLogText } from "@/lib/log-redact";

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

/**
 * FXC-10 follow-up: a session check that THREW (rather than answering with an error) is treated as "unavailable",
 * which could also hide a real bug. Logs it on the server (OPS-06 structured line, event `auth.session_check_threw`):
 * where, the error's name and its message redacted, the request id when the caller has it; never the request, its
 * cookies or a token.
 */
export function logSessionCheckThrow(where: "proxy" | "readSession", error: unknown, requestId?: string | null): void {
  logEvent("error", "auth.session_check_threw", { where, request_id: requestId, ...errorFields(error) });
}

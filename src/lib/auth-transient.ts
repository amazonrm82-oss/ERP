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

/**
 * FXC-10 follow-up: a session check that THREW (rather than answering with an error) is treated as "unavailable",
 * which could also hide a real bug. Logs it on the server with a short tag: the error's name and its message with quoted
 * and token-like runs redacted (redactLogText), never
 * the request, its cookies or a token.
 */
export function logSessionCheckThrow(where: "proxy" | "readSession", error: unknown): void {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? redactLogText(error.message).slice(0, 300) : "";
  console.error(`[auth:${where}] session check threw; treated as unavailable: ${name}${message ? `: ${message}` : ""}`);
}

/**
 * An error message may echo part of its input: V8's JSON SyntaxError quotes about ten characters of it, which could be
 * the start of a token. Quoted runs become "…" and token-like runs (16+ letters, digits, - or _, with any dot-separated
 * parts after them, as in a JWT) become [redacted].
 */
export function redactLogText(text: string): string {
  return text.replace(/"[^"]*"/g, '"…"').replace(/[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+)*/g, "[redacted]");
}

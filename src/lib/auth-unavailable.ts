// FXC-10: the sign-in service did not answer (a network error, a 5xx, a rate limit). That is not a signed-out user:
// nobody is sent to the login page and nothing is dropped; the screen says it is a communication problem and offers
// to try again. Safe to import in client components (no dependencies).

/** The digest of the error a page throws when the session cannot be checked; error boundaries show it as such. */
export const AUTH_UNAVAILABLE_DIGEST = "CRM_AUTH_UNAVAILABLE";

export const AUTH_UNAVAILABLE_TITLE = "בעיית תקשורת";
export const AUTH_UNAVAILABLE_MESSAGE = "בעיית תקשורת עם שירות הכניסה. לא נותקתם מהמערכת; נסו שוב בעוד רגע.";

/**
 * Thrown by pages when the session cannot be checked right now. Next.js keeps an error's own digest in production,
 * so the error boundary can tell this one apart without its message.
 */
export class AuthUnavailableError extends Error {
  readonly digest = AUTH_UNAVAILABLE_DIGEST;

  constructor() {
    super("auth service unavailable");
    this.name = "AuthUnavailableError";
  }
}

export function isAuthUnavailableDigest(digest: string | undefined): boolean {
  return digest === AUTH_UNAVAILABLE_DIGEST;
}

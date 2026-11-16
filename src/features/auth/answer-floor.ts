// USR-10 review (timing): the answers that must not tell whether an address has an account (the one-time sign-in link and the
// reset email) take the same time whatever Auth did. Auth answers "no such user" quickly and an existing account only after it
// sent the email, so the action waits until a fixed floor from the start of the Auth call, plus a little random jitter.
// Not next/server after(): the Auth call through @supabase/ssr sets the PKCE code-verifier cookie, which must be on THIS
// response, and after() runs once the response has gone.
// Residual (accepted): an Auth call slower than the floor (a slow mail server) still shows in the time it takes.

export const AUTH_ANSWER_FLOOR_MS = 1_500;
export const AUTH_ANSWER_JITTER_MS = 250;

/** How long to wait after an Auth call that took `elapsedMs`: up to the floor, plus 0..249 ms. */
export function authAnswerWait(elapsedMs: number, random: () => number = Math.random): number {
  const rest = Number.isFinite(elapsedMs) ? Math.max(0, AUTH_ANSWER_FLOOR_MS - elapsedMs) : AUTH_ANSWER_FLOOR_MS;
  const jitter = Math.min(AUTH_ANSWER_JITTER_MS - 1, Math.max(0, Math.floor(random() * AUTH_ANSWER_JITTER_MS)));
  return Math.ceil(rest) + jitter;
}

/** Waits until the floor (from `startedAt`, a performance.now() value taken right before the Auth call). */
export async function padAuthAnswer(startedAt: number): Promise<void> {
  const wait = authAnswerWait(performance.now() - startedAt);
  await new Promise<void>((resolve) => setTimeout(resolve, wait));
}

// OPS-02 (owner's answer (42) ד, 2 November 2026): the shared per-sender limit of the secret-link pages counts only "not
// found" answers (a guessed or dead link), never a real customer's views. A route handler marks the one response that means
// "this link does not exist" (never a real link's "unavailable" or an error that answers 404 too), and the guard of
// src/lib/public-sender-server.ts records a miss only for a marked response. Nothing goes on the wire.

const notFound = new WeakSet<Response>();

/** Marks a response as the link's "not found" answer and returns it. */
export function markNotFound(response: Response): Response {
  notFound.add(response);
  return response;
}

/** Whether a handler marked this response as "not found". */
export function isMarkedNotFound(response: Response): boolean {
  return notFound.has(response);
}

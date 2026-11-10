// OPS-06: every request carries one id, so the lines one request writes can be found together. The proxy sets it on the
// request as x-crm-request-id: Vercel's own x-vercel-id when it has a sane shape (the same id the Vercel dashboard shows),
// else a fresh random one. A visitor's own x-crm-request-id never counts: the proxy always overwrites it.
// No Node imports here: the proxy uses this file too.

export const REQUEST_ID_HEADER = "x-crm-request-id";

const REQUEST_ID_SHAPE = /^[A-Za-z0-9:_-]{1,128}$/;

/** The value when it has the shape of a request id, else null (never a visitor's arbitrary text in a log line). */
export function validRequestId(value: string | null | undefined): string | null {
  return typeof value === "string" && REQUEST_ID_SHAPE.test(value) ? value : null;
}

/** The id the proxy gives a request: Vercel's x-vercel-id when valid, else a new random one. */
export function requestIdFor(headers: { get(name: string): string | null }): string {
  return validRequestId(headers.get("x-vercel-id")) ?? crypto.randomUUID();
}

/**
 * The id of a request: Vercel's x-vercel-id when valid (the proxy copies the same value into x-crm-request-id, and on
 * a path the proxy does not match a visitor could send their own x-crm-request-id), else the proxy's id, else null.
 */
export function requestIdOf(headers: { get(name: string): string | null }): string | null {
  return validRequestId(headers.get("x-vercel-id")) ?? validRequestId(headers.get(REQUEST_ID_HEADER));
}

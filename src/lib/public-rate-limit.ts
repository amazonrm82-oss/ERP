// OPS-02: one answer for every public path that a rate limit refuses. The limits themselves live in the database, inside
// each public page's own service_role function (counted per link and per sender with the keyed IP hash of FXS-11, so
// they hold across every server instance); this file only turns their "rate limited" answer into the same HTTP reply
// everywhere: status 429, a Retry-After header, never cached, and one Hebrew message. Pages cannot answer 429 (an App
// Router page renders with 200), so they show RATE_LIMITED_PAGE_TEXT instead. The inventory of every public path and
// its limit is tests/unit/public-rate-limits.test.ts.

/** Every view and submit window of the public functions is 10 minutes. */
export const RATE_LIMIT_RETRY_SECONDS = 600;

/** What a route answers when a limit refused the request (forms, booking, decisions, files, the calendar feed). */
export const RATE_LIMITED_TEXT = "נשלחו יותר מדי בקשות בזמן קצר. נסו שוב בעוד כמה דקות.";

/** What a public page shows when its view limit refused the visit. */
export const RATE_LIMITED_PAGE_TEXT = "הדף נפתח יותר מדי פעמים בזמן קצר. נסו שוב בעוד כמה דקות.";

/** The headers of every 429: when to try again, and never kept by a browser or a CDN. */
export function rateLimitHeaders(retryAfterSeconds: number = RATE_LIMIT_RETRY_SECONDS): Record<string, string> {
  return { "Retry-After": String(Math.max(1, Math.round(retryAfterSeconds))), "Cache-Control": "no-store" };
}

type Options = { retryAfterSeconds?: number; headers?: Record<string, string> };

/** A JSON route's 429. The body keeps the route's own shape (the page's script reads `message`). */
export function rateLimitedJson(body: object, options: Options = {}): Response {
  return Response.json(body, { status: 429, headers: { ...options.headers, ...rateLimitHeaders(options.retryAfterSeconds) } });
}

/** A plain-text route's 429 (file downloads, the calendar feed). */
export function rateLimitedText(message: string = RATE_LIMITED_TEXT, options: Options = {}): Response {
  return new Response(message, {
    status: 429,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...options.headers, ...rateLimitHeaders(options.retryAfterSeconds) },
  });
}

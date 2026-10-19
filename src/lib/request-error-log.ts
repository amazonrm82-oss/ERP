import { redactLogText } from "@/lib/auth-transient";

// FXC-13: one server log line per error Next.js captures, keyed by the same digest the error screen shows as
// "קוד שגיאה לתמיכה". Only what helps find the cause: the digest, the route, the kind of request, the method, the path
// without its query (a query can carry a token or personal details), and the error's name and redacted message.
// Never headers, cookies or the body.

// Public secret-link pages and routes carry their token in the path (CLAUDE.md hard rule 5): the segment after one of
// these prefixes is a secret, and the log shows "[token]" instead. Longest prefixes first. Every other path stays
// readable.
const TOKEN_PREFIXES = [
  "/api/forms/booking/manage/",
  "/api/forms/booking/",
  "/api/forms/card/",
  "/api/forms/quote/",
  "/api/forms/widget/",
  "/api/calendar-feed/",
  "/api/in/",
  "/f/book/manage/",
  "/f/book/",
  "/f/card/",
  "/f/quote/",
  "/f/q/",
  "/f/w/",
  "/f/widget/",
] as const;
// a form's own link (/f/<token>, /api/forms/<token>): the next segment, unless it is one of the fixed words above
const FORM_PREFIXES: { prefix: string; fixed: readonly string[] }[] = [
  { prefix: "/api/forms/", fixed: ["booking", "card", "quote", "widget"] },
  { prefix: "/f/", fixed: ["book", "card", "quote", "q", "w", "widget", "embed.js"] },
];

function redactSegment(path: string, prefix: string): string {
  const rest = path.slice(prefix.length);
  const end = rest.indexOf("/");
  const segment = end === -1 ? rest : rest.slice(0, end);
  return segment === "" ? path : `${prefix}[token]${end === -1 ? "" : rest.slice(end)}`;
}

/** The path with the secret token of a public link replaced by "[token]". */
export function redactPublicPath(path: string): string {
  for (const prefix of TOKEN_PREFIXES) {
    if (path.startsWith(prefix)) return redactSegment(path, prefix);
  }
  for (const { prefix, fixed } of FORM_PREFIXES) {
    if (!path.startsWith(prefix)) continue;
    const segment = path.slice(prefix.length).split("/")[0];
    return fixed.includes(segment) ? path : redactSegment(path, prefix);
  }
  return path;
}

export type RequestErrorInfo = { path: string; method: string };
export type RequestErrorContext = { routePath?: string; routeType?: string; renderSource?: string };

export function requestErrorLine(error: unknown, request: RequestErrorInfo, context: RequestErrorContext): string {
  const digest =
    typeof error === "object" && error !== null && "digest" in error && typeof (error as { digest: unknown }).digest === "string"
      ? (error as { digest: string }).digest
      : "none";
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? redactLogText(error.message).slice(0, 300) : "";
  const path = redactPublicPath(request.path.split("?")[0]).slice(0, 200);
  return [
    `[error] code=${digest}`,
    `route=${context.routePath ?? "?"}`,
    `type=${context.routeType ?? "?"}${context.renderSource ? `/${context.renderSource}` : ""}`,
    `${request.method} ${path}`,
    `${name}${message ? `: ${message}` : ""}`,
  ].join(" ");
}

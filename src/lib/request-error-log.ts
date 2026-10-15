import { redactLogText } from "@/lib/auth-transient";

// FXC-13: one server log line per error Next.js captures, keyed by the same digest the error screen shows as
// "קוד שגיאה לתמיכה". Only what helps find the cause: the digest, the route, the kind of request, the method, the path
// without its query (a query can carry a token or personal details), and the error's name and redacted message.
// Never headers, cookies or the body.

export type RequestErrorInfo = { path: string; method: string };
export type RequestErrorContext = { routePath?: string; routeType?: string; renderSource?: string };

export function requestErrorLine(error: unknown, request: RequestErrorInfo, context: RequestErrorContext): string {
  const digest =
    typeof error === "object" && error !== null && "digest" in error && typeof (error as { digest: unknown }).digest === "string"
      ? (error as { digest: string }).digest
      : "none";
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? redactLogText(error.message).slice(0, 300) : "";
  const path = request.path.split("?")[0].slice(0, 200);
  return [
    `[error] code=${digest}`,
    `route=${context.routePath ?? "?"}`,
    `type=${context.routeType ?? "?"}${context.renderSource ? `/${context.renderSource}` : ""}`,
    `${request.method} ${path}`,
    `${name}${message ? `: ${message}` : ""}`,
  ].join(" ");
}

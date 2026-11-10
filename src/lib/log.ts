import { redactLogText } from "@/lib/log-redact";
import { redactPublicPath } from "@/lib/request-error-log";
import { validRequestId } from "@/lib/request-id";

// OPS-06: structured server logs. One JSON line per event: {time, level, event, request_id, org_id?, ...safe fields}.
// Only the field names listed in LOG_FIELDS are written; any other key is dropped. Every value is judged by its field's
// kind: ids must look like ids, codes like codes, a path loses its query and the token of a public link, and free text
// (an error's message, a report's details) is redacted: quoted runs, token-like runs, email addresses and phone-like
// numbers never reach the log. Never headers, cookies, a request body or a message's content.
// This is the ONLY server file that writes with console.* (tests/unit/structured-logs.test.ts refuses any other).

export type LogLevel = "info" | "warn" | "error";

type FieldKind = "uuid" | "id" | "code" | "route" | "path" | "object_path" | "text" | "plain" | "number" | "boolean";

/** The closed list of field names a log line may carry, with the kind each value is judged by. */
export const LOG_FIELDS = {
  request_id: "id",
  org_id: "uuid",
  route: "route",
  route_type: "code",
  method: "code",
  path: "path",
  digest: "code",
  where: "code",
  scope: "code",
  kind: "code",
  code: "code",
  status: "code",
  reason: "code",
  answer: "code",
  what: "code",
  report: "code",
  error_name: "code",
  job_id: "uuid",
  file_id: "uuid",
  object_path: "object_path",
  error: "text",
  details: "plain",
  count: "number",
  busy: "boolean",
} as const satisfies Record<string, FieldKind>;

export type LogField = keyof typeof LOG_FIELDS;
export type LogFields = Partial<Record<LogField, string | number | boolean | null | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_.:/?[\]-]{1,64}$/;
// a route pattern: route groups and parallel routes keep their (group) and @slot; "?" = not known
const ROUTE = /^[A-Za-z0-9()@[\]._/?-]{1,200}$/;
// two or more dot-separated runs of 16+ characters: a JWT or a signed token, never a code
const JWT_SHAPE = /[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]{16,})+/;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OBJECT_PATH = /^[0-9a-f-]{36}(\/[0-9a-f-]{36}(\.[a-z0-9]{1,8})?)*$/i;
const EVENT = /^[a-z0-9_.-]{1,80}$/;

/**
 * Secrets and personal details out of a text: the word after Bearer/Basic and after token=/key=/secret=/password=
 * (any length), email addresses, JWT-shaped runs, base64-style runs of 16+ characters holding a digit, "+" or "/",
 * and phone-like numbers (8+ digits and separators; an ISO date such as 2026-11-10 is kept). With `wordRuns`, also
 * every quoted run and every 16+ run of word characters (redactLogText), for text that came from outside the app.
 */
function redactSecrets(text: string, wordRuns: boolean): string {
  let out = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\b(Bearer|Basic)(\s+)\S+/gi, "$1$2[redacted]")
    .replace(/\b(token|key|secret|password)=[^\s&;,"']*/gi, "$1=[redacted]")
    .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+/g, "[email]")
    .replace(new RegExp(JWT_SHAPE.source, "g"), "[redacted]")
    .replace(/[A-Za-z0-9+/=_-]{16,}/g, (run) => (/[0-9+/]/.test(run) ? "[redacted]" : run));
  if (wordRuns) out = redactLogText(out);
  return out.replace(/(?<![\d.-])(?!\d{4}-\d{2}-\d{2}(?!\d))\+?\d[\d\s().-]{6,}\d/g, "[number]");
}

/** Free text from outside the app (an error's message) with secrets and personal details taken out, at most 300. */
export function redactText(text: string): string {
  return redactSecrets(text, true).slice(0, 300);
}

/**
 * A request path for the log: no query or fragment, percent-escapes decoded, repeated slashes collapsed, the token of
 * a public link hidden (prefixes compared in lower case), emails and token-like segments (16+ characters with a
 * digit, not a uuid) redacted, printable ASCII only, at most 200.
 */
function cleanPath(value: string): string {
  let path = value.split("?")[0].split("#")[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // a malformed escape: judged as it is
  }
  path = path.replace(/[^\x21-\x7e]/g, "").replace(/\/{2,}/g, "/");
  const lower = path.toLowerCase();
  const hidden = redactPublicPath(lower);
  if (hidden !== lower) path = hidden;
  return path
    .split("/")
    .map((segment) => {
      if (segment.includes("@")) return "[email]";
      if (UUID_SEGMENT.test(segment)) return segment;
      return /^[A-Za-z0-9_\-+=.~%]{16,}$/.test(segment) && /\d/.test(segment) ? "[redacted]" : segment;
    })
    .join("/")
    .slice(0, 200);
}

function cleanValue(kind: FieldKind, value: unknown): string | number | boolean | undefined {
  switch (kind) {
    case "uuid":
      return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : undefined;
    case "id":
      return typeof value === "string" ? (validRequestId(value) ?? undefined) : undefined;
    case "code":
      if (typeof value === "number" && Number.isFinite(value)) return value;
      return typeof value === "string" && CODE.test(value) && !JWT_SHAPE.test(value) ? value : undefined;
    case "route":
      return typeof value === "string" && ROUTE.test(value) && !JWT_SHAPE.test(value) ? value : undefined;
    case "path":
      return typeof value === "string" ? cleanPath(value) : undefined;
    case "object_path":
      return typeof value === "string" && OBJECT_PATH.test(value) ? value : undefined;
    case "text":
      return typeof value === "string" ? redactText(value) : undefined;
    case "plain":
      // text the server wrote itself from names and codes (a report's schema paths, a fixed failure line). It never
      // carries a database error's fields: those go in `error`. The same secret, email and number redaction as `text`
      // runs first (long names stay readable), then only these characters are kept.
      return typeof value === "string"
        ? redactSecrets(value, false).replace(/[^A-Za-z0-9_ .,:;/[\]()=-]/g, "").slice(0, 300)
        : undefined;
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    case "boolean":
      return typeof value === "boolean" ? value : undefined;
  }
}

/** The line as an object: allowed fields only, each value cleaned; a value that fails its kind is left out. */
export function logRecord(level: LogLevel, event: string, fields: LogFields = {}, now: Date = new Date()): Record<string, unknown> {
  const record: Record<string, unknown> = {
    time: now.toISOString(),
    level,
    event: EVENT.test(event) ? event : "invalid_event",
    request_id: null,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(LOG_FIELDS, key) || value === undefined || value === null) continue;
    const clean = cleanValue(LOG_FIELDS[key as LogField], value);
    if (clean !== undefined && clean !== "") record[key] = clean;
  }
  return record;
}

/** Writes one structured line: errors and warnings to stderr, the rest to stdout. Never throws. */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  try {
    const line = JSON.stringify(logRecord(level, event, fields));
    if (level === "info") console.log(line);
    else console.error(line);
  } catch {
    // a log line never breaks the request
  }
}

/** The name and redacted message of a thrown value, as log fields. */
export function errorFields(error: unknown): Pick<LogFields, "error_name" | "error"> {
  if (error instanceof Error) return { error_name: error.name, error: error.message };
  return { error_name: typeof error };
}

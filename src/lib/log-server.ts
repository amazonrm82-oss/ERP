import { headers } from "next/headers";

import { logEvent, type LogFields, type LogLevel } from "@/lib/log";
import { requestIdOf } from "@/lib/request-id";

// OPS-06: a structured line from code that runs inside a request (Server Components of dynamic pages, Server Actions,
// route handlers): the request id is read from the request the proxy marked. Outside a request (a build, a cached
// function) there is none and the line carries request_id null. Never use it from a page that may be prerendered: reading
// headers() there makes the page dynamic; log with logEvent from @/lib/log instead.

/** The current request's id, or null outside a request. */
export async function currentRequestId(): Promise<string | null> {
  try {
    return requestIdOf(await headers());
  } catch {
    return null;
  }
}

/** One structured line with the current request's id. Never throws. */
export async function serverLog(level: LogLevel, event: string, fields: LogFields = {}): Promise<void> {
  const requestId = fields.request_id ?? (await currentRequestId());
  logEvent(level, event, { ...fields, request_id: requestId });
}

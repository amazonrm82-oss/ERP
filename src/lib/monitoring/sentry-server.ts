import * as Sentry from "@sentry/nextjs";

import type { LogFields } from "@/lib/log";
import { baseSentryOptions, keptIntegrations, scrubEvent, type MonitoringIdentity } from "@/lib/monitoring/sentry-rules";

// OPS-05: Sentry on the Node server and the edge runtime. Started only by register() in src/instrumentation.ts, only in Vercel
// production with SENTRY_DSN and a valid SENTRY_ACTIVE_FROM. SENTRY_ACTIVE_FROM is read again for every event, so a server
// that started before the day opens on the day without a restart (owner (427) א), and an unset value closes it.

let started = false;

type Integration = ReturnType<typeof Sentry.getDefaultIntegrations>[number];

export function startServerMonitoring(dsn: string, environment: string, extra: Integration[] = []): void {
  if (started) return;
  started = true;
  Sentry.init({
    ...baseSentryOptions(dsn, environment),
    // on Node, the integrations of sentry-node.ts (an unhandled-rejection capture that never prints); none on the edge
    integrations: (defaults) => [...keptIntegrations(defaults), ...extra],
    beforeSend(event, hint) {
      const identity = (hint?.data as { monitoringIdentity?: MonitoringIdentity } | undefined)?.monitoringIdentity ?? null;
      return scrubEvent(event, { activeFrom: process.env.SENTRY_ACTIVE_FROM, identity, original: hint?.originalException });
    },
  });
}

/**
 * One captured request error (onRequestError), with the same safe fields the log line carries: the digest the user sees
 * as the support code, the route, the kind of request, the method and the request id, as tags; the user and business ids
 * as the identity. The path itself is not sent here (the event's request URL, scrubbed, is the SDK's own).
 */
export function reportRequestError(error: unknown, fields: LogFields, identity: MonitoringIdentity): void {
  if (!started) return;
  try {
    const tags: Record<string, string> = {};
    for (const key of ["digest", "route", "route_type", "method", "request_id"] as const) {
      const value = fields[key];
      if (typeof value === "string") tags[key] = value;
    }
    Sentry.withScope((scope) => {
      scope.setTags(tags);
      Sentry.captureException(error, { data: { monitoringIdentity: identity } });
    });
  } catch {
    // monitoring never breaks the request
  }
}

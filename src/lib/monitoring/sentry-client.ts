import * as Sentry from "@sentry/nextjs";

import { currentMonitoringIdentity } from "@/lib/monitoring/identity-client";
import { baseSentryOptions, isCustomerPagePath, scrubEvent } from "@/lib/monitoring/sentry-rules";

// OPS-05: Sentry in the browser. Loaded only by src/instrumentation-client.ts, only in production with a DSN and a valid
// NEXT_PUBLIC_SENTRY_ACTIVE_FROM, and never on a public customer page (/f/...). Every event passes scrubEvent (closed before
// the day, nothing personal) and is dropped while the page shown is a customer page.

export function startClientMonitoring(dsn: string, environment: string, activeFrom: string | undefined): void {
  Sentry.init({
    ...baseSentryOptions(dsn, environment),
    beforeSend(event, hint) {
      if (isCustomerPagePath(window.location.pathname)) return null;
      return scrubEvent(event, { activeFrom, identity: currentMonitoringIdentity(), original: hint?.originalException });
    },
  });
}

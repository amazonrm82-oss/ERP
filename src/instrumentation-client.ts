import { isCustomerPagePath, parseActiveFrom, sentryConfigured } from "@/lib/monitoring/sentry-rules";

// OPS-05: error monitoring in the browser (Sentry, EU region). Loaded only in Vercel production with a DSN and a valid
// NEXT_PUBLIC_SENTRY_ACTIVE_FROM (owner (427) א: events leave only from that Israel day, judged again for every event), and
// never on a public customer page: there the Sentry module is not even fetched. Fire-and-forget: an error before it loads
// is missed.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN ?? "";
const environment = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "";
const activeFrom = process.env.NEXT_PUBLIC_SENTRY_ACTIVE_FROM;

try {
  if (sentryConfigured(dsn, environment) && parseActiveFrom(activeFrom) !== null && !isCustomerPagePath(window.location.pathname)) {
    void import("@/lib/monitoring/sentry-client")
      .then(({ startClientMonitoring }) => startClientMonitoring(dsn.trim(), environment, activeFrom))
      .catch(() => undefined);
  }
} catch {
  // monitoring never breaks the page
}

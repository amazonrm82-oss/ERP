import type { Instrumentation } from "next";

import { logEvent } from "@/lib/log";
import { monitoringIdentityOf } from "@/lib/monitoring/request-identity";
import { parseActiveFrom, sentryConfigured } from "@/lib/monitoring/sentry-rules";
import { requestErrorFields } from "@/lib/request-error-log";

type ServerMonitoring = typeof import("@/lib/monitoring/sentry-server");
let monitoring: ServerMonitoring | null = null;

// OPS-05: Sentry (EU region) on the server and the edge runtime, only in Vercel production with SENTRY_DSN and a valid
// SENTRY_ACTIVE_FROM; otherwise the module is never loaded. Events leave only from that Israel day (judged for every event).
export async function register(): Promise<void> {
  try {
    const dsn = process.env.SENTRY_DSN;
    if (!sentryConfigured(dsn, process.env.VERCEL_ENV) || parseActiveFrom(process.env.SENTRY_ACTIVE_FROM) === null) return;
    const loaded = await import("@/lib/monitoring/sentry-server");
    // Node-only integrations; Next.js replaces NEXT_RUNTIME per bundle, so the edge bundle never holds sentry-node.ts
    const extra = process.env.NEXT_RUNTIME === "nodejs" ? (await import("@/lib/monitoring/sentry-node")).nodeIntegrations() : [];
    loaded.startServerMonitoring((dsn ?? "").trim(), "production", extra);
    monitoring = loaded;
  } catch {
    // monitoring never stops the server
  }
}

// FXC-13: every server error Next.js captures (pages, route handlers, Server Actions, the proxy) is written to the
// server log with the code the user sees on the error screen, so support can find it; since OPS-06 as one structured
// line (event `request.error`) with the request id. Until SENTRY_ACTIVE_FROM this line is the only record; since OPS-05 the
// same error also goes to Sentry with the same safe fields and the user and business ids only.
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  const fields = requestErrorFields(error, request, context);
  logEvent("error", "request.error", fields);
  if (monitoring) {
    const header = (name: string) => {
      const value = request.headers?.[name];
      return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
    };
    monitoring.reportRequestError(error, fields, monitoringIdentityOf(header, request.path));
  }
};

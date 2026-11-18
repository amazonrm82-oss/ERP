import { onUnhandledRejectionIntegration } from "@sentry/nextjs";

// OPS-05: Node-only Sentry integrations (the edge build has none of these). Loaded by register() in src/instrumentation.ts
// only when NEXT_RUNTIME is "nodejs". Unhandled rejections are captured and never printed: mode "none" (OPS-06: src/lib/log.ts
// is the only writer of log output).
export function nodeIntegrations() {
  return [onUnhandledRejectionIntegration({ mode: "none" })];
}

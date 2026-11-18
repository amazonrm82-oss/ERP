import { cleanIdentity, type MonitoringIdentity } from "@/lib/monitoring/sentry-rules";

// OPS-05: the ids of the signed-in person and the business the browser's error events belong to. Set by the business frame
// (MonitoringIdentity in src/features/monitoring/), never on a public customer page. Kept on globalThis, not in a module
// variable, because Sentry is started from instrumentation-client in its own chunk; holds ids only.

const KEY = "__mxMonitoringIdentity";

type Holder = { [KEY]?: MonitoringIdentity };

export function setMonitoringIdentity(identity: Partial<MonitoringIdentity> | null): void {
  (globalThis as Holder)[KEY] = cleanIdentity(identity);
}

export function clearMonitoringIdentity(): void {
  delete (globalThis as Holder)[KEY];
}

export function currentMonitoringIdentity(): MonitoringIdentity {
  return cleanIdentity((globalThis as Holder)[KEY]);
}

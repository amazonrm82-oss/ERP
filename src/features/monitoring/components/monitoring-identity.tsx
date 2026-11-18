"use client";

import { useEffect } from "react";

import { clearMonitoringIdentity, setMonitoringIdentity } from "@/lib/monitoring/identity-client";

/**
 * OPS-05: the business frame tells the browser's error monitoring which user and business an error belongs to: the two ids
 * only, never a name, email or phone. Rendered only inside /o/[orgId] (never on a public customer page); cleared when the
 * frame goes away, so an error on another page carries no one.
 */
export function MonitoringIdentity({ userId, orgId }: { userId: string; orgId: string }) {
  useEffect(() => {
    setMonitoringIdentity({ userId, orgId });
    return () => clearMonitoringIdentity();
  }, [userId, orgId]);
  return null;
}

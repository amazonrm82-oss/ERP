import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type IntegrationEvent = { id: string; kind: string; code: string | null; hits: number; lastAt: string };

export type IntegrationConnection = {
  id: string;
  provider: string;
  name: string;
  externalId: string | null;
  status: "pending" | "connected" | "disconnected" | "error";
  secretSetAt: string | null;
  verifiedAt: string | null;
  lastErrorCode: string | null;
  events: IntegrationEvent[];
};

/** How many log lines a connection shows on the screen (newest first). */
export const EVENTS_SHOWN = 30;

const STATUSES = new Set(["pending", "connected", "disconnected", "error"]);

/**
 * INT-01/INT-03: the business's connections and the newest lines of each one's sync log, read with the user's session
 * (owners and admins; RLS decides). Nothing here can read a secret: the connection row holds none.
 */
export async function listIntegrationConnections(orgId: string): Promise<IntegrationConnection[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("integrations")
      .select("id, provider, name, external_id, status, secret_set_at, verified_at, last_error_code")
      .eq("organization_id", orgId)
      .order("created_at")
      .order("id"),
    "integrations",
  );
  const logs = await Promise.all(
    rows.map(async (row) =>
      must(
        await supabase
          .from("integration_events")
          .select("id, kind, code, hits, last_at")
          .eq("organization_id", orgId)
          .eq("integration_id", row.id)
          .order("last_at", { ascending: false })
          .order("id")
          .limit(EVENTS_SHOWN),
        "integration_events",
      ),
    ),
  );
  return rows.map((row, i) => ({
    id: row.id,
    provider: row.provider,
    name: row.name,
    externalId: row.external_id,
    status: (STATUSES.has(row.status) ? row.status : "pending") as IntegrationConnection["status"],
    secretSetAt: row.secret_set_at,
    verifiedAt: row.verified_at,
    lastErrorCode: row.last_error_code,
    events: logs[i].map((e) => ({ id: e.id, kind: e.kind, code: e.code, hits: e.hits, lastAt: e.last_at })),
  }));
}

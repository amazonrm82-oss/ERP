import "server-only";

import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

export type MetaFormMapping = {
  id: string;
  metaFormId: string | null;
  name: string;
  assignMode: "owner" | "round_robin";
  ownerId: string | null;
  teamId: string | null;
  isActive: boolean;
};

/** null while the connection is not verified (its first lead not fetched yet): no counts are shown then (review finding 1). */
export type MetaArrivalCounts = { pending: number; givenUp: number; refused: number; done: number; lastReceivedAt: string | null };

export type MetaConnection = {
  id: string;
  pageId: string;
  name: string;
  status: "pending" | "connected" | "disconnected" | "error";
  secretSetAt: string | null;
  lastErrorCode: string | null;
  forms: MetaFormMapping[];
  counts: MetaArrivalCounts | null;
};

const STATUSES = new Set(["pending", "connected", "disconnected", "error"]);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * CAP-11: the business's Meta pages, their form mappings and arrival counts (owners and admins; RLS decides). Nothing
 * here can read a page token: the connection row holds none, and the ciphertext is in schema app.
 */
export async function listMetaConnections(orgId: string): Promise<MetaConnection[]> {
  const supabase = await createClient();
  const [connections, forms, summary] = await Promise.all([
    supabase
      .from("integrations")
      .select("id, external_id, name, status, secret_set_at, last_error_code")
      .eq("organization_id", orgId)
      .eq("provider", "meta_lead_ads")
      .order("created_at")
      .order("id"),
    supabase
      .from("meta_lead_forms")
      .select("id, integration_id, meta_form_id, name, assign_mode, owner_id, team_id, is_active")
      .eq("organization_id", orgId)
      .order("created_at")
      .order("id"),
    supabase.rpc("meta_lead_summary", { p_org: orgId }),
  ]);
  const rows = must(connections, "integrations");
  const formRows = must(forms, "meta_lead_forms");
  const counts = (must(summary, "meta_lead_summary") ?? {}) as Record<string, Record<string, unknown>>;
  return rows.map((row) => {
    const c = counts[row.id] ?? {};
    return {
      id: row.id,
      pageId: row.external_id ?? "",
      name: row.name,
      status: (STATUSES.has(row.status) ? row.status : "pending") as MetaConnection["status"],
      secretSetAt: row.secret_set_at,
      lastErrorCode: row.last_error_code,
      forms: formRows
        .filter((f) => f.integration_id === row.id)
        // the page's default row last
        .sort((a, b) => Number(a.meta_form_id === null) - Number(b.meta_form_id === null))
        .map((f) => ({
          id: f.id,
          metaFormId: f.meta_form_id,
          name: f.name,
          assignMode: f.assign_mode === "owner" ? "owner" : "round_robin",
          ownerId: f.owner_id,
          teamId: f.team_id,
          isActive: f.is_active,
        })),
      counts:
        c.verified === true
          ? {
              pending: num(c.pending),
              givenUp: num(c.given_up),
              refused: num(c.refused),
              done: num(c.done),
              lastReceivedAt: typeof c.last_received_at === "string" ? c.last_received_at : null,
            }
          : null,
    };
  });
}

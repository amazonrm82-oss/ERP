import "server-only";

import { publicSenderAddress } from "@/lib/ip-prefix";
import { clientIp, keyedIpHash } from "@/lib/keyed-ip-hash";
import { serverLog } from "@/lib/log-server";
import { createServiceClient } from "@/lib/supabase/service";

import type { LandingEventKind } from "./measure";

/**
 * LND-14 (owner (388) א, CLAUDE.md hard rule 5, LND-13's pattern): with the service key this calls only public.landing_event()
 * (kind, the folded source, and the keyed IP hash of scope `landing`, of which the database keeps only a bucket number). Counts
 * only, never a row per visitor; no cookie or visitor id. Without a hash (no hash secret, or no client address) or the
 * service key nothing is counted. It never throws and never changes what the visitor gets: over the limit is silent.
 * Read the headers in the request and pass them in (the call may run inside after()).
 */
export async function recordLandingEvent(kind: LandingEventKind, source: string, headers: Headers): Promise<void> {
  try {
    const ipHash = keyedIpHash(publicSenderAddress(clientIp(headers)), "landing");
    if (!ipHash) return;
    const service = createServiceClient();
    if (!service) return;
    const { error } = await service.rpc("landing_event", { p_kind: kind, p_source: source, p_ip_hash: ipHash });
    if (error) await serverLog("warn", "landing_event.failed", { code: error.code });
  } catch {
    // measurement never breaks a page
  }
}

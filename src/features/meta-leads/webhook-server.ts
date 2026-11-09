import "server-only";

import { after } from "next/server";

import { secretKeyring } from "@/features/integrations/keys-server";
import type { Json } from "@/lib/database.types";
import { createServiceClient } from "@/lib/supabase/service";

import { metaGraphProvider } from "./graph/select";
import { sweepRoute, verifyRoute, webhookRoute, type Claimed, type MetaLeadsDb, type MetaLeadsDeps, type ReceiveAnswer } from "./webhook";

/**
 * CAP-11 (owner, 4 November 2026, answer (126) א; CLAUDE.md hard rule 5): the Meta Lead Ads webhook and its sweep. With
 * the service role it calls only public.meta_lead_receive(), public.meta_lead_claim() and public.meta_lead_finish(); no
 * table is read or written directly. The client is made only after the signature (or the sweep's shared secret) passed.
 */
function database(): MetaLeadsDb | null {
  const supabase = createServiceClient();
  if (!supabase) return null;
  return {
    async receive(pageId, leads) {
      const { data, error } = await supabase.rpc("meta_lead_receive", { p_page_id: pageId, p_leads: leads as unknown as Json });
      if (error) throw new Error("receive failed");
      return data as unknown as ReceiveAnswer;
    },
    async claim(limit, ids) {
      const { data, error } = await supabase.rpc("meta_lead_claim", { p_limit: limit, p_ids: ids });
      if (error) throw new Error("claim failed");
      return Array.isArray(data) ? (data as unknown as Claimed[]) : [];
    },
    async finish(arrival, lease, lead, failure) {
      const { data, error } = await supabase.rpc("meta_lead_finish", {
        p_arrival: arrival,
        p_lease: lease,
        p_lead: lead as unknown as Json,
        p_error: failure,
      });
      if (error) return "error";
      return typeof data === "string" ? data : "error";
    },
  };
}

const deps = (): MetaLeadsDeps => ({
  env: process.env,
  db: database,
  provider: metaGraphProvider(),
  keys: secretKeyring(),
  // review finding 4: Meta gets its answer first; the fetch of the new leads runs after it
  defer: (work) => after(work),
});

export const metaVerify = (request: Request) => verifyRoute(request, deps());
export const metaWebhook = (request: Request) => webhookRoute(request, deps());
export const metaSweep = (request: Request) => sweepRoute(request, deps());

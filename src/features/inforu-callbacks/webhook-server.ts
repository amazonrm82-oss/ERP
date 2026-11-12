import "server-only";

import { logEvent } from "@/lib/log";
import { createServiceClient } from "@/lib/supabase/service";

import { inforuInboundRoute, inforuStatusRoute, type InforuWebhookDb } from "./webhook";

/**
 * SMS-05 (owner (318) א), wave 3 use (2): the service_role path of InforU's two callbacks. After the secret check
 * (webhook.ts) it calls only public.sms_delivery_status() and public.sms_inbound_reply(); no table is read or
 * written with the service key. Log lines carry counts only, never the body, a number or a text.
 */
function database(): InforuWebhookDb | null {
  const supabase = createServiceClient();
  if (!supabase) return null;
  return {
    deliveryStatus: async (items) => {
      const { data, error } = await supabase.rpc("sms_delivery_status", { p_provider: "inforu", p_items: items });
      if (error) throw new Error("delivery status failed");
      return data;
    },
    inboundReply: async (item) => {
      const { data, error } = await supabase.rpc("sms_inbound_reply", { p_provider: "inforu", p_phone: item.phone, p_body: item.body });
      if (error) throw new Error("inbound reply failed");
      return data;
    },
  };
}

const log = (event: string, fields: { count?: number; status?: string; reason?: string }) => logEvent("info", event, fields);

export function inforuStatus(request: Request, secret: string) {
  return inforuStatusRoute(request, secret, { db: database(), log });
}

export function inforuInbound(request: Request, secret: string) {
  return inforuInboundRoute(request, secret, { db: database(), log });
}

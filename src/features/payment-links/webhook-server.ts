import "server-only";

import type { Json } from "@/lib/database.types";
import { logEvent } from "@/lib/log";
import { createServiceClient } from "@/lib/supabase/service";

import { paymentProvider } from "./providers/select";
import { paymentWebhookRoute, type PaymentWebhookDb } from "./webhook";

/**
 * LNK-04, wave 3 use (2) of hard rule 5: the service_role path of the payment provider's webhook. The route in webhook.ts
 * calls `database` only after the provider's signature check passed, so no service-key client exists before it; it calls
 * only public.payment_link_webhook(); no table is read or written with the service key. Log lines carry codes only, never
 * the body.
 */
function database(): PaymentWebhookDb | null {
  const supabase = createServiceClient();
  if (!supabase) return null;
  return {
    record: async (provider, event) => {
      const { data, error } = await supabase.rpc("payment_link_webhook", { p_provider: provider, p_event: event as Json });
      if (error) throw new Error("payment webhook failed");
      return data;
    },
  };
}

const log = (event: string, fields: { status?: string; reason?: string }) => logEvent("info", event, fields);

export function paymentWebhook(request: Request, provider: string) {
  return paymentWebhookRoute(request, provider, { provider: () => paymentProvider(), db: database, log });
}

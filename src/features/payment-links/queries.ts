import "server-only";

import { cache } from "react";

import { canRecordPayments } from "@/features/permissions/keys";
import { getMyPermissions } from "@/features/permissions/queries";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { paymentProviderCode } from "./providers/select";
import type { PaymentProviderCode } from "./providers/types";
import { effectiveLinkStatus, SOURCE_COLUMN, type PaymentLinkSource, type PaymentLinkStatus } from "./schema";

export type PaymentLinksAccess = {
  // LNK-01 (owner (270) (1) א): without a provider the whole feature is hidden
  provider: PaymentProviderCode | null;
  // the plan holds `payments` and `payment_links`
  inPlan: boolean;
  // whoever records payments (PAY-06), in a writable business
  canCreate: boolean;
};

/** Who sees and makes payment links here. The database decides again on every write. */
export const getPaymentLinksAccess = cache(async (orgId: string): Promise<PaymentLinksAccess> => {
  const provider = paymentProviderCode();
  if (!provider) return { provider: null, inPlan: false, canCreate: false };
  const [payments, links, context, granted] = await Promise.all([
    orgHasFeature(orgId, "payments"),
    orgHasFeature(orgId, "payment_links"),
    getOrgContext(orgId),
    getMyPermissions(orgId),
  ]);
  const inPlan = payments && links;
  return { provider, inPlan, canCreate: inPlan && context.canWrite && canRecordPayments(context.role, granted) };
});

export type PaymentLink = {
  id: string;
  amountAgorot: number;
  maxInstallments: number;
  expiresOn: string;
  title: string | null;
  provider: string;
  hostedUrl: string | null;
  status: PaymentLinkStatus;
  createdAt: string;
};

/** The source's links, newest first (at most 50), read with the user's session (the source's own read rule). */
export async function listPaymentLinks(orgId: string, source: PaymentLinkSource): Promise<PaymentLink[]> {
  const supabase = await createClient();
  const rows = must(
    await supabase
      .from("payment_links")
      .select("id, amount_agorot, max_installments, expires_on, expires_at, title, provider, hosted_url, status, created_at")
      .eq("organization_id", orgId)
      .eq(SOURCE_COLUMN[source.kind], source.id)
      .order("created_at", { ascending: false })
      .order("id")
      .limit(50),
    "payment_links",
  );
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    amountAgorot: r.amount_agorot,
    maxInstallments: r.max_installments,
    expiresOn: r.expires_on,
    title: r.title,
    provider: r.provider,
    hostedUrl: r.hosted_url,
    status: effectiveLinkStatus(r.status, r.expires_at, now),
    createdAt: r.created_at,
  }));
}

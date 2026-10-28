import "server-only";

import { cache } from "react";

import { getMyPermissions } from "@/features/permissions/queries";
import { canRecordPayments } from "@/features/permissions/keys";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { parseCollection, type Collection, type CollectionFilters } from "./collection";

// COL-01: the collection screen reads public.collection_documents with the user's session (invoker: RLS decides).

export type CollectionAccess = {
  // the plan holds collection, documents and payments
  inPlan: boolean;
  // BAL-01's rule (app.can_record_payments): owners, admins and managers, or the personal key record_payments
  canOpen: boolean;
};

export const getCollectionAccess = cache(async (orgId: string): Promise<CollectionAccess> => {
  const [collection, documents, payments, context, granted] = await Promise.all([
    orgHasFeature(orgId, "collection"),
    orgHasFeature(orgId, "documents"),
    orgHasFeature(orgId, "payments"),
    getOrgContext(orgId),
    getMyPermissions(orgId),
  ]);
  const inPlan = collection && documents && payments;
  return { inPlan, canOpen: inPlan && canRecordPayments(context.role, granted) };
});

export async function getCollection(orgId: string, filters: CollectionFilters): Promise<Collection> {
  const supabase = await createClient();
  const raw = must(
    await supabase.rpc("collection_documents", {
      p_org: orgId,
      p_owner: filters.owner,
      p_overdue: filters.overdue,
      p_bucket: filters.bucket,
      p_customer_kind: filters.customer?.kind ?? null,
      p_customer_id: filters.customer?.id ?? null,
    }),
    "collection documents",
  );
  return parseCollection(raw);
}

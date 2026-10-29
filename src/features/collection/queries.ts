import "server-only";

import { cache } from "react";

import { getMyPermissions } from "@/features/permissions/queries";
import { canRecordPayments } from "@/features/permissions/keys";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { must } from "@/lib/db-read";
import { createClient } from "@/lib/supabase/server";

import { coverageOf } from "./promise";
import {
  parseCollection,
  type Collection,
  type CollectionFilters,
} from "./collection";

// COL-01: the collection screen reads public.collection_documents with the user's session (invoker: RLS decides).

export type CollectionAccess = {
  // the plan holds collection, documents and payments
  inPlan: boolean;
  // BAL-01's rule (app.can_record_payments): owners, admins and managers, or the personal key record_payments
  canOpen: boolean;
  // COL-03: may record, change and remove payment promises
  canPromise: boolean;
};

export const getCollectionAccess = cache(
  async (orgId: string): Promise<CollectionAccess> => {
    const [collection, documents, payments, context, granted] =
      await Promise.all([
        orgHasFeature(orgId, "collection"),
        orgHasFeature(orgId, "documents"),
        orgHasFeature(orgId, "payments"),
        getOrgContext(orgId),
        getMyPermissions(orgId),
      ]);
    const inPlan = collection && documents && payments;
    const canOpen = inPlan && canRecordPayments(context.role, granted);
    // COL-03: recording a payment promise also needs a writable business
    return { inPlan, canOpen, canPromise: canOpen && context.canWrite };
  },
);

export async function getCollection(
  orgId: string,
  filters: CollectionFilters,
): Promise<Collection> {
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

export type DocumentPromise = {
  date: string;
  note: string | null;
  kind: "document" | "customer";
};

/**
 * COL-03: each document's effective promise (RLS: whoever reads the promise and the document): its own promise, else the
 * newest customer promise that covered it (the rule of app.document_promise). `own` holds the document's own promise only.
 */
export async function listPromises(
  orgId: string,
  documentIds: string[],
): Promise<{
  effective: Map<string, DocumentPromise>;
  own: Map<string, DocumentPromise>;
}> {
  const effective = new Map<string, DocumentPromise>();
  const own = new Map<string, DocumentPromise>();
  if (documentIds.length === 0) return { effective, own };
  const supabase = await createClient();
  const [owned, covered] = await Promise.all([
    supabase
      .from("payment_promises")
      .select("document_id, promised_date, note")
      .eq("organization_id", orgId)
      .in("document_id", documentIds),
    supabase
      .from("payment_promise_documents")
      .select("promise_id, document_id")
      .eq("organization_id", orgId)
      .in("document_id", documentIds),
  ]);
  for (const r of must(owned, "payment promises")) {
    if (r.document_id)
      own.set(r.document_id, {
        date: r.promised_date,
        note: r.note,
        kind: "document",
      });
  }
  const links = must(covered, "covered documents");
  const promiseIds = [...new Set(links.map((l) => l.promise_id))];
  const customer = promiseIds.length
    ? must(
        await supabase
          .from("payment_promises")
          .select("id, promised_date, note, created_at")
          .eq("organization_id", orgId)
          .in("id", promiseIds),
        "customer promises",
      )
    : [];
  const byId = new Map(customer.map((p) => [p.id, p]));
  for (const link of links) {
    const p = byId.get(link.promise_id);
    if (!p) continue;
    const seen = effective.get(link.document_id) as
      | (DocumentPromise & { createdAt?: string })
      | undefined;
    if (!seen || (seen.createdAt ?? "") < p.created_at) {
      effective.set(
        link.document_id,
        Object.assign(
          { date: p.promised_date, note: p.note, kind: "customer" as const },
          { createdAt: p.created_at },
        ),
      );
    }
  }
  // the document's own promise always wins
  for (const [doc, p] of own) effective.set(doc, p);
  for (const [doc, p] of effective)
    effective.set(doc, { date: p.date, note: p.note, kind: p.kind });
  return { effective, own };
}

export type CustomerPromise = DocumentPromise & {
  // answer (6) ב: how many open documents it covered when made (all of the customer's, a count only); null = not shown
  covered: number | null;
};

/** COL-03: the customer promise of a contact (without a company) or a company, if there is one the user reads. */
export async function getCustomerPromise(
  orgId: string,
  customer: { kind: "contact" | "company"; id: string },
): Promise<CustomerPromise | null> {
  const supabase = await createClient();
  const row = must(
    await supabase
      .from("payment_promises")
      .select("id, promised_date, note")
      .eq("organization_id", orgId)
      .eq(
        customer.kind === "contact" ? "contact_id" : "company_id",
        customer.id,
      )
      .maybeSingle(),
    "customer promise",
  );
  if (!row) return null;
  const covered = await getPromiseCoverage(orgId, row.id);
  return {
    date: row.promised_date,
    note: row.note,
    kind: "customer",
    covered,
  };
}

/**
 * COL-03 answer (6) ב: the number of documents a customer promise covers (public.payment_promise_coverage: counts only, for
 * whoever records payments and reads the promise); null when it is not answered.
 */
export async function getPromiseCoverage(
  orgId: string,
  promiseId: string,
): Promise<number | null> {
  const supabase = await createClient();
  // a count is a detail: a failed read leaves the line out instead of failing the whole record page
  const { data, error } = await supabase.rpc("payment_promise_coverage", {
    p_org: orgId,
    p_promises: [promiseId],
  });
  if (error) return null;
  return coverageOf(data, promiseId);
}

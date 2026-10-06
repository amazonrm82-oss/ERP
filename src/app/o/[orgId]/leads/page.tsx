import type { Metadata } from "next";

import { Pagination } from "@/components/pagination";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { LeadFilters } from "@/features/leads/components/lead-filters";
import { LeadsTable } from "@/features/leads/components/leads-table";
import { getLeadLookups, listLeads } from "@/features/leads/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";

export const metadata: Metadata = { title: "לידים" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LeadsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const { canWrite } = await getOrgContext(orgId);

  const search = firstParam(query.q).trim();
  const statusParam = firstParam(query.status);
  const statusId = isUuid(statusParam) ? statusParam : null;
  const page = parsePage(query.page);

  const [lookups, { leads, hasMore }] = await Promise.all([
    getLeadLookups(orgId),
    listLeads(orgId, { search, statusId, page }),
  ]);

  const isFiltered = search !== "" || statusId !== null;
  const hrefFor = (target: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (statusId) next.set("status", statusId);
    if (target > 1) next.set("page", String(target));
    const suffix = next.toString();
    return suffix ? `${paths.leads(orgId)}?${suffix}` : paths.leads(orgId);
  };

  const newLeadButton = canWrite ? (
    <ButtonLink href={paths.leadNew(orgId)}>
      <PlusIcon className="size-4.5" />
      ליד חדש
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader title="לידים" description="פניות שעוד לא סוננו. ליד מתאים ממירים לאיש קשר ועסקה." actions={newLeadButton} />
      <LeadFilters orgId={orgId} statuses={lookups.statuses} search={search} statusId={statusId ?? ""} />

      {leads.length > 0 ? (
        <LeadsTable orgId={orgId} leads={leads} statuses={lookups.statuses} sources={lookups.sources} />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {isFiltered || page > 1 ? (
            <EmptyState
              title="לא נמצאו לידים"
              description="אין לידים שמתאימים לחיפוש או לסינון. נסו מילה אחרת או נקו את הסינון."
              action={
                <ButtonLink href={paths.leads(orgId)} variant="secondary">
                  ניקוי הסינון
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState
              title="עוד אין לידים"
              description="כאן יופיעו כל הפניות החדשות, עם מקור, סטטוס ובעלים. אפשר להתחיל בהוספת הליד הראשון."
              action={newLeadButton}
            />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}

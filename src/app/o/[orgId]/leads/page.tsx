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
import { listTags } from "@/features/tags/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
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
  const context = await getOrgContext(orgId);
  const { canWrite } = context;

  const search = firstParam(query.q).trim();
  const statusParam = firstParam(query.status);
  const statusId = isUuid(statusParam) ? statusParam : null;
  const tagParam = firstParam(query.tag);
  const tagId = isUuid(tagParam) ? tagParam : null;
  const page = parsePage(query.page);

  const [lookups, tags, views, { leads, hasMore }] = await Promise.all([
    getLeadLookups(orgId),
    listTags(orgId),
    viewChips(orgId, "lead", context),
    listLeads(orgId, { search, statusId, tagId, page }),
  ]);

  const isFiltered = search !== "" || statusId !== null || tagId !== null;
  const hrefFor = (target: number) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (statusId) next.set("status", statusId);
    if (tagId) next.set("tag", tagId);
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
      <SavedViewsBar
        orgId={orgId}
        objectType="lead"
        listPath={paths.leads(orgId)}
        views={views}
        current={{ q: search || undefined, status: statusId ?? undefined, tag: tagId ?? undefined }}
        canSave={context.role !== "viewer"}
        canShare={context.role === "owner" || context.role === "admin"}
      />
      <LeadFilters orgId={orgId} statuses={lookups.statuses} tags={tags} search={search} statusId={statusId ?? ""} tagId={tagId ?? ""} />

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

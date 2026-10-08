import type { Metadata } from "next";
import Link from "next/link";

import { Pagination } from "@/components/pagination";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { LeadFilters } from "@/features/leads/components/lead-filters";
import { LeadsBoard } from "@/features/leads/components/leads-board";
import { LeadsTable } from "@/features/leads/components/leads-table";
import { getLeadBoard, getLeadLookups, listLeads } from "@/features/leads/queries";
import { getOrgContext } from "@/features/shell/queries";
import { listTags } from "@/features/tags/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { cn } from "@/lib/cn";
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
  const boardView = firstParam(query.view) === "board";

  const [lookups, tags, views, list, board] = await Promise.all([
    getLeadLookups(orgId),
    listTags(orgId),
    viewChips(orgId, "lead", context),
    boardView ? null : listLeads(orgId, { search, statusId, tagId, page }),
    boardView ? getLeadBoard(orgId, { search, tagId }) : null,
  ]);
  const leads = list?.leads ?? [];
  const hasMore = list?.hasMore ?? false;

  const isFiltered = search !== "" || statusId !== null || tagId !== null;
  // the same filters in the other view (the board has no status filter)
  const viewHref = (target: "table" | "board") => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (tagId) next.set("tag", tagId);
    if (target === "table" && statusId) next.set("status", statusId);
    if (target === "board") next.set("view", "board");
    const suffix = next.toString();
    return suffix ? `${paths.leads(orgId)}?${suffix}` : paths.leads(orgId);
  };
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
      <div className="mb-3 flex justify-end">
        <nav aria-label="תצוגה" className="flex gap-1 rounded-md border border-line bg-surface p-1">
          {(
            [
              { key: "table", label: "טבלה" },
              { key: "board", label: "לוח" },
            ] as const
          ).map((option) => {
            const active = (option.key === "board") === boardView;
            return (
              <Link
                key={option.key}
                href={viewHref(option.key)}
                aria-current={active ? "page" : undefined}
                className={cn("rounded px-3 py-1.5 text-[0.9375rem]", active ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink-soft hover:bg-canvas")}
              >
                {option.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <LeadFilters orgId={orgId} statuses={lookups.statuses} tags={tags} search={search} statusId={statusId ?? ""} tagId={tagId ?? ""} board={boardView} />

      {board ? (
        <LeadsBoard orgId={orgId} board={board} canWrite={canWrite} />
      ) : leads.length > 0 ? (
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

      {board ? null : <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />}
    </>
  );
}

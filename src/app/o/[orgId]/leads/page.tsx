import type { Metadata } from "next";
import Link from "next/link";

import { ListTools } from "@/components/list-tools";
import { Pagination } from "@/components/ui/pagination";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { PlusIcon, InboxIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { inlineEditing } from "@/features/inline-edit/server";
import { activeReasonNames } from "@/features/disqualify-reasons/queries";
import { LeadCards } from "@/features/leads/components/lead-cards";
import { LeadFilters } from "@/features/leads/components/lead-filters";
import { LeadsBoard } from "@/features/leads/components/leads-board";
import { getScoreNumbers } from "@/features/data-quality/queries";
import { LeadsTable } from "@/features/leads/components/leads-table";
import { getLeadBoard, getLeadLookups, LEAD_DEFAULT_SORT, LEAD_SORT_COLUMNS, listLeads } from "@/features/leads/queries";
import { CUSTOM_PREFIX, resolveColumns } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { ExportMenu, exportHref } from "@/features/list-export/components/export-menu";
import { AdvancedFilter } from "@/features/list-filters/components/advanced-filter";
import { prepareListFilter } from "@/features/list-filters/prepare";
import { getMyPermissions } from "@/features/permissions/queries";
import { canExport } from "@/features/reports/request";
import { getOrgContext } from "@/features/shell/queries";
import { whatsappListContext } from "@/features/whatsapp/templates";
import { listTags } from "@/features/tags/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { cn } from "@/lib/cn";
import { isUuid, paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";
import { nextSort, parseSort, sortValue, type CustomSortKey, type Sort } from "@/lib/sort";

export const metadata: Metadata = { title: "לידים" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LeadsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  // PRM-01: extra permissions (export)
  const granted = await getMyPermissions(orgId);
  const { canWrite } = context;

  const search = firstParam(query.q).trim();
  const statusParam = firstParam(query.status);
  const statusId = isUuid(statusParam) ? statusParam : null;
  const tagParam = firstParam(query.tag);
  const tagId = isUuid(tagParam) ? tagParam : null;
  const page = parsePage(query.page);
  const boardView = firstParam(query.view) === "board";
  const listColumns = await getListColumns(orgId, "lead");
  // the advanced filter (LST-05), checked against the list's fields
  const filter = await prepareListFilter(orgId, "lead", firstParam(query.f), context.user.id, listColumns.fields);
  const filterParam = filter.tree ? JSON.stringify(filter.tree) : null;
  // any column the list can show sorts, custom fields included (LST-02, LST-03)
  const sortKeys = [...Object.keys(LEAD_SORT_COLUMNS), ...listColumns.fields.map((f) => `${CUSTOM_PREFIX}${f.key}`)] as Array<
    keyof typeof LEAD_SORT_COLUMNS | CustomSortKey
  >;
  const sort = parseSort(firstParam(query.sort), sortKeys, LEAD_DEFAULT_SORT as Sort<(typeof sortKeys)[number]>);

  const [editing, lookups, tags, viewData, list, board, reasons] = await Promise.all([
    inlineEditing(orgId, context),
    getLeadLookups(orgId),
    listTags(orgId),
    viewChips(orgId, "lead", context),
    boardView ? null : listLeads(orgId, { search, statusId, tagId, page, sort, filter: filter.logic }),
    boardView ? getLeadBoard(orgId, { search, tagId, filter: filter.logic }) : null,
    canWrite ? activeReasonNames(orgId) : [],
  ]);
  const leads = list?.leads ?? [];
  const hasMore = list?.hasMore ?? false;

  const isFiltered = search !== "" || statusId !== null || tagId !== null || filter.tree !== null;
  // the same filters in the other view (the board has no status filter)
  const viewHref = (target: "table" | "board") => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (tagId) next.set("tag", tagId);
    if (target === "table" && statusId) next.set("status", statusId);
    if (target === "table" && sortValue(sort) !== sortValue(LEAD_DEFAULT_SORT)) next.set("sort", sortValue(sort));
    if (filterParam) next.set("f", filterParam);
    if (target === "board") next.set("view", "board");
    const suffix = next.toString();
    return suffix ? `${paths.leads(orgId)}?${suffix}` : paths.leads(orgId);
  };
  const views = viewData.chips;
  // a saved view in use (LST-04): its columns replace the user's own while it is open
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("lead", activeView.config.columns, listColumns.catalog) : listColumns.columns;
  // DQL-01: scores only when the column is shown
  const completeness = shownColumns.some((c) => c.key === "completeness") && leads.length > 0 ? await getScoreNumbers(orgId, "lead", leads.map((l) => l.id)) : undefined;

  const listHref = (target: number, sortParam: string) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (statusId) next.set("status", statusId);
    if (tagId) next.set("tag", tagId);
    if (sortParam !== sortValue(LEAD_DEFAULT_SORT)) next.set("sort", sortParam);
    if (filterParam) next.set("f", filterParam);
    if (activeView) next.set("sv", activeView.id);
    if (target > 1) next.set("page", String(target));
    const suffix = next.toString();
    return suffix ? `${paths.leads(orgId)}?${suffix}` : paths.leads(orgId);
  };
  const hrefFor = (target: number) => listHref(target, sortValue(sort));
  // a new sort starts again from the first page; dates start with the newest, the score (LEAD-05) with the highest
  const sortHref = (key: string) =>
    listHref(1, sortValue(nextSort(sort, key as (typeof sortKeys)[number], key !== "created" && key !== "last_contact" && key !== "score")));

  const newLeadButton = canWrite ? (
    <ButtonLink href={paths.leadNew(orgId)}>
      <PlusIcon className="size-4.5" />
      ליד חדש
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="לידים"
        description="פניות שעוד לא סוננו. ליד מתאים ממירים לאיש קשר ועסקה."
        actions={
          <>
            <ButtonLink href={paths.leadsWaiting(orgId)} variant="secondary">
              לידים שמחכים
            </ButtonLink>
            {newLeadButton}
          </>
        }
      />
      <ListTools active={(filter.tree ? 1 : 0) + (statusId ? 1 : 0) + (tagId ? 1 : 0)}>
        <SavedViewsBar
          orgId={orgId}
          objectType="lead"
          listPath={paths.leads(orgId)}
          views={views}
          activeViewId={activeView?.id ?? null}
          current={{ q: search || undefined, f: filterParam ?? undefined, status: statusId ?? undefined, tag: tagId ?? undefined }}
          currentSort={sortValue(sort)}
          currentColumns={shownColumns}
          teams={viewData.teams}
          canSave={context.role !== "viewer"}
          canShare={context.role === "owner" || context.role === "admin"}
        />
        <div className="flex flex-wrap items-start gap-2 md:justify-end">
          {canExport(context.role, granted) ? <ExportMenu href={exportHref(paths.leads(orgId), listHref(1, sortValue(sort)))} /> : null}
          <AdvancedFilter
            fields={filter.fields}
            current={filter.tree}
            skipped={filter.skipped}
            listPath={paths.leads(orgId)}
            keep={Object.fromEntries(
              Object.entries({ q: search, status: boardView ? "" : (statusId ?? ""), tag: tagId ?? "", view: boardView ? "board" : "" }).filter(([, v]) => v),
            )}
          />
          {boardView ? null : activeView?.config.columns ? (
            <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
          ) : (
            <ColumnsPanel orgId={orgId} object="lead" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
          )}
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
                  className={cn(
                    "rounded px-3 py-1.5 text-md",
                    active ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink-soft hover:bg-canvas",
                  )}
                >
                  {option.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </ListTools>

      <LeadFilters orgId={orgId} statuses={lookups.statuses} tags={tags} search={search} statusId={statusId ?? ""} tagId={tagId ?? ""} board={boardView} />

      {board ? (
        <LeadsBoard orgId={orgId} board={board} canWrite={canWrite} reasons={reasons} />
      ) : leads.length > 0 ? (
        <>
          <LeadCards orgId={orgId} leads={leads} statuses={lookups.statuses} showScore={shownColumns.some((c) => c.key === "score")} className="md:hidden" whatsapp={whatsappListContext(context)} />
          <div className="hidden md:block">
            <LeadsTable
              orgId={orgId}
              leads={leads}
              statuses={lookups.statuses}
              sources={lookups.sources}
              columns={shownColumns}
              catalog={listColumns.catalog}
              fields={listColumns.fields}
              sort={sort}
              sortHref={sortHref}
              editing={editing}
              tags={tags}
              reasons={reasons}
              completeness={completeness}
              whatsapp={whatsappListContext(context)}
            />
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {isFiltered || page > 1 ? (
            <EmptyState kind="search"
              title="לא נמצאו לידים"
              description="אין לידים שמתאימים לחיפוש או לסינון. נסו מילה אחרת או נקו את הסינון."
              action={
                <ButtonLink href={paths.leads(orgId)} variant="secondary">
                  ניקוי הסינון
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState icon={<InboxIcon />}
              title="עוד אין לידים"
              description="כאן יופיעו כל הפניות החדשות, עם מקור, סטטוס ואחראי. אפשר להתחיל בהוספת הליד הראשון."
              action={newLeadButton}
            />
          )}
        </div>
      )}

      {board ? null : <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />}
    </>
  );
}

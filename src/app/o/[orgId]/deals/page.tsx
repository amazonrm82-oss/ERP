import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { Pagination } from "@/components/ui/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { DealsBoard } from "@/features/deals/components/deals-board";
import { DealsTable } from "@/features/deals/components/deals-table";
import { DEAL_DEFAULT_SORT, DEAL_SORT_COLUMNS, getBoard, getPipeline, listDeals, listPipelines } from "@/features/deals/queries";
import { inlineEditing } from "@/features/inline-edit/server";
import { CUSTOM_PREFIX, resolveColumns } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { ExportMenu, exportHref } from "@/features/list-export/components/export-menu";
import { AdvancedFilter } from "@/features/list-filters/components/advanced-filter";
import { prepareListFilter } from "@/features/list-filters/prepare";
import { canExport } from "@/features/reports/request";
import { getOrgContext, type OrgContext } from "@/features/shell/queries";
import { listTags } from "@/features/tags/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { cn } from "@/lib/cn";
import { formatMoney, formatNumber } from "@/lib/format";
import { isUuid, paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";
import { nextSort, parseSort, sortValue, type CustomSortKey, type Sort } from "@/lib/sort";

export const metadata: Metadata = { title: "עסקאות" };

type Query = Record<string, string | string[] | undefined>;
type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Query>;
};

const NO_PIPELINE = (
  <>
    <PageHeader title="עסקאות" />
    <div className="rounded-lg border border-line bg-surface">
      <EmptyState title="אין פייפליין מכירות" description="כדי לנהל עסקאות צריך פייפליין עם שלבים. מנהל המערכת יכול להוסיף אחד בהגדרות." />
    </div>
  </>
);

/** Board or table, and which pipeline: shown above both views. */
function ViewNav({ orgId, pipelineId, pipelines, table }: { orgId: string; pipelineId: string; pipelines: Array<{ id: string; name: string; isDefault: boolean }>; table: boolean }) {
  const href = (pipeline: { id: string; isDefault: boolean }, asTable: boolean) => {
    const params = new URLSearchParams();
    if (!pipeline.isDefault) params.set("pipeline", pipeline.id);
    if (asTable) params.set("view", "table");
    const qs = params.toString();
    return qs ? `${paths.deals(orgId)}?${qs}` : paths.deals(orgId);
  };
  const current = pipelines.find((p) => p.id === pipelineId) ?? { id: pipelineId, isDefault: true };
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      {pipelines.length > 1 ? (
        <nav aria-label="פייפליינים" className="flex flex-wrap gap-2">
          {pipelines.map((pipeline) => {
            const active = pipeline.id === pipelineId;
            return (
              <Link
                key={pipeline.id}
                href={href(pipeline, table)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-9 items-center rounded-full border px-3.5 text-sm",
                  active ? "border-accent bg-accent-soft font-semibold text-accent-strong" : "border-line bg-surface hover:bg-canvas",
                )}
              >
                {pipeline.name}
              </Link>
            );
          })}
        </nav>
      ) : (
        <span />
      )}
      <nav aria-label="תצוגה" className="flex gap-1 rounded-md border border-line bg-surface p-1">
        {(
          [
            { key: "board", label: "לוח", asTable: false },
            { key: "table", label: "טבלה", asTable: true },
          ] as const
        ).map((option) => (
          <Link
            key={option.key}
            href={href(current, option.asTable)}
            aria-current={option.asTable === table ? "page" : undefined}
            className={cn("rounded px-3 py-1.5 text-md", option.asTable === table ? "bg-accent-soft font-semibold text-accent-strong" : "text-ink-soft hover:bg-canvas")}
          >
            {option.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export default async function DealsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const context = await getOrgContext(orgId);
  const query = await searchParams;
  if (firstParam(query.view) === "table") {
    return <DealsTableView orgId={orgId} context={context} query={query} />;
  }

  const { canWrite } = context;
  const requested = firstParam(query.pipeline);
  const showClosed = firstParam(query.closed) === "1";
  const fullStage = firstParam(query.stage);
  const [board, pipelines] = await Promise.all([getBoard(orgId, requested, { showClosed, fullStage }), listPipelines(orgId)]);

  if (!board) {
    return NO_PIPELINE;
  }

  const openStages = board.stages.filter((stage) => stage.kind === "open");
  const openCount = openStages.reduce((sum, stage) => sum + (board.totals[stage.id]?.count ?? 0), 0);
  const openTotal = openStages.reduce((sum, stage) => sum + (board.totals[stage.id]?.amountAgorot ?? 0), 0);
  const anyDeals = Object.values(board.totals).some((t) => t.count > 0);
  // the board's address with one setting changed, keeping the others
  const boardHref = (change: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const current: Record<string, string | null> = { pipeline: requested ?? null, closed: showClosed ? "1" : null, stage: fullStage ?? null, ...change };
    for (const [key, value] of Object.entries(current)) if (value) params.set(key, value);
    const qs = params.toString();
    return qs ? `${paths.deals(orgId)}?${qs}` : paths.deals(orgId);
  };

  const newDealButton = canWrite ? (
    <ButtonLink href={`${paths.dealNew(orgId)}?pipeline=${board.pipeline.id}`}>
      <PlusIcon className="size-4.5" />
      עסקה חדשה
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="עסקאות"
        description={
          anyDeals ? `פייפליין ${board.pipeline.name}: ${formatNumber(openCount)} עסקאות פתוחות בשווי ${formatMoney(openTotal)}.` : `פייפליין ${board.pipeline.name}`
        }
        actions={newDealButton}
      />

      <ViewNav orgId={orgId} pipelineId={board.pipeline.id} pipelines={pipelines} table={false} />

      <p className="mb-3 text-sm">
        <Link href={boardHref({ closed: showClosed ? null : "1" })} className="text-accent-strong underline underline-offset-4">
          {showClosed ? "הסתרת עסקאות שנסגרו" : "הצגת עסקאות שנסגרו (בהצלחה ואבודות)"}
        </Link>
      </p>

      {!anyDeals ? (
        <div className="mb-5 rounded-lg border border-line bg-surface">
          <EmptyState
            title="עוד אין עסקאות"
            description="עסקה נוצרת כשממירים ליד, או ידנית מכאן. בלוח רואים בכל רגע כמה כסף נמצא בכל שלב."
            action={newDealButton}
          />
        </div>
      ) : null}

      <DealsBoard
        orgId={orgId}
        board={board}
        canWrite={canWrite}
        hrefs={{
          showClosed: boardHref({ closed: "1" }),
          ...Object.fromEntries(board.stages.map((stage) => [stage.id, boardHref({ stage: stage.id })])),
        }}
      />
    </>
  );
}

/**
 * The table view (LST-09): one pipeline's deals, open and closed, with search,
 * tag, advanced filter, sorting, the user's columns, saved views, editing in
 * the cell, bulk actions and export, as in the other lists.
 */
async function DealsTableView({ orgId, context, query }: { orgId: string; context: OrgContext; query: Query }) {
  const requested = firstParam(query.pipeline);
  const [pipeline, pipelines] = await Promise.all([getPipeline(orgId, requested), listPipelines(orgId)]);
  if (!pipeline) {
    return NO_PIPELINE;
  }
  const search = firstParam(query.q).trim();
  const tagParam = firstParam(query.tag);
  const tagId = isUuid(tagParam) ? tagParam : null;
  const page = parsePage(query.page);
  const listColumns = await getListColumns(orgId, "deal");
  const filter = await prepareListFilter(orgId, "deal", firstParam(query.f), context.user.id, listColumns.fields, { stages: pipeline.stages });
  const filterParam = filter.tree ? JSON.stringify(filter.tree) : null;
  const sortKeys = [...Object.keys(DEAL_SORT_COLUMNS), ...listColumns.fields.map((f) => `${CUSTOM_PREFIX}${f.key}`)] as Array<keyof typeof DEAL_SORT_COLUMNS | CustomSortKey>;
  const sort = parseSort(firstParam(query.sort), sortKeys, DEAL_DEFAULT_SORT as Sort<(typeof sortKeys)[number]>);
  const pipelineParam = pipelines.find((p) => p.id === pipeline.id)?.isDefault ? null : pipeline.id;

  const [editing, tags, viewData, { deals, hasMore }] = await Promise.all([
    inlineEditing(orgId, context),
    listTags(orgId),
    viewChips(orgId, "deal", context),
    listDeals(orgId, { pipelineId: pipeline.id, search, tagId, page, sort, filter: filter.logic }),
  ]);
  const views = viewData.chips;
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("deal", activeView.config.columns, listColumns.catalog) : listColumns.columns;

  const listHref = (target: number, sortParam: string) => {
    const next = new URLSearchParams();
    next.set("view", "table");
    if (pipelineParam) next.set("pipeline", pipelineParam);
    if (search) next.set("q", search);
    if (tagId) next.set("tag", tagId);
    if (sortParam !== sortValue(DEAL_DEFAULT_SORT)) next.set("sort", sortParam);
    if (filterParam) next.set("f", filterParam);
    if (activeView) next.set("sv", activeView.id);
    if (target > 1) next.set("page", String(target));
    return `${paths.deals(orgId)}?${next.toString()}`;
  };
  const hrefFor = (target: number) => listHref(target, sortValue(sort));
  const sortHref = (key: string) => listHref(1, sortValue(nextSort(sort, key as (typeof sortKeys)[number], key !== "created" && key !== "amount")));
  const isFiltered = search !== "" || tagId !== null || filter.tree !== null;

  const newDealButton = context.canWrite ? (
    <ButtonLink href={`${paths.dealNew(orgId)}?pipeline=${pipeline.id}`}>
      <PlusIcon className="size-4.5" />
      עסקה חדשה
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader title="עסקאות" description={`פייפליין ${pipeline.name}`} actions={newDealButton} />
      <ViewNav orgId={orgId} pipelineId={pipeline.id} pipelines={pipelines} table />
      <SavedViewsBar
        orgId={orgId}
        objectType="deal"
        listPath={paths.deals(orgId)}
        views={views}
        activeViewId={activeView?.id ?? null}
        current={{ view: "table", pipeline: pipelineParam ?? undefined, q: search || undefined, f: filterParam ?? undefined, tag: tagId ?? undefined }}
        currentSort={sortValue(sort)}
        currentColumns={shownColumns}
        teams={viewData.teams}
        canSave={context.role !== "viewer"}
        canShare={context.role === "owner" || context.role === "admin"}
      />
      <div className="mb-3 flex flex-wrap items-start justify-end gap-2">
        {canExport(context.role) ? <ExportMenu href={exportHref(paths.deals(orgId), listHref(1, sortValue(sort)))} /> : null}
        <AdvancedFilter
          fields={filter.fields}
          current={filter.tree}
          skipped={filter.skipped}
          listPath={paths.deals(orgId)}
          keep={Object.fromEntries(Object.entries({ view: "table", pipeline: pipelineParam ?? "", q: search, tag: tagId ?? "" }).filter(([, v]) => v))}
        />
        {activeView?.config.columns ? (
          <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
        ) : (
          <ColumnsPanel orgId={orgId} object="deal" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
        )}
      </div>

      <Form action={paths.deals(orgId)} role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <input type="hidden" name="view" value="table" />
        {pipelineParam ? <input type="hidden" name="pipeline" value={pipelineParam} /> : null}
        <TextField label="חיפוש עסקאות" hideLabel name="q" type="search" placeholder="חיפוש לפי שם העסקה" defaultValue={search} className="min-w-0 flex-[1_1_14rem]" />
        <button type="submit" className={buttonClasses("secondary")}>
          <SearchIcon className="size-4.5" />
          חיפוש
        </button>
      </Form>

      {deals.length > 0 ? (
        <DealsTable
          orgId={orgId}
          deals={deals}
          stages={pipeline.stages}
          columns={shownColumns}
          catalog={listColumns.catalog}
          fields={listColumns.fields}
          sort={sort}
          sortHref={sortHref}
          editing={editing}
          tags={tags}
        />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {isFiltered || page > 1 ? (
            <EmptyState
              title="לא נמצאו עסקאות"
              description="אין עסקאות שמתאימות לחיפוש או לסינון. נסו מילה אחרת או נקו את הסינון."
              action={
                <ButtonLink href={`${paths.deals(orgId)}?view=table${pipelineParam ? `&pipeline=${pipelineParam}` : ""}`} variant="secondary">
                  ניקוי הסינון
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState title="עוד אין עסקאות בפייפליין הזה" description="עסקה נוצרת כשממירים ליד, או ידנית מכאן." action={newDealButton} />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}

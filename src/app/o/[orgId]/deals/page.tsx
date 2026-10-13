import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { Pagination } from "@/components/ui/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon, BoardIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { BoardFilters } from "@/features/deals/components/board-filters";
import { DealsBoard } from "@/features/deals/components/deals-board";
import { activeLossReasons, listLossReasons } from "@/features/deal-loss-reasons/queries";
import { listMembers, listTeams } from "@/features/settings/queries";
import { isCalendarDate } from "@/lib/calendar-date";
import { getStuckDeals } from "@/features/deals/stuck";
import { closeWindowSetup } from "@/features/deals/close-window";
import { DealsTable } from "@/features/deals/components/deals-table";
import { BOARD_PREFERENCE, MAX_BOARD_FIELDS } from "@/features/deals/board-fields";
import { DEAL_DEFAULT_SORT, DEAL_SORT_COLUMNS, FILTERED_TOTALS_LIMIT, getBoard, getBoardFields, getPipeline, isBoardFiltered, listDeals, listPipelines } from "@/features/deals/queries";
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
      <EmptyState icon={<BoardIcon />} title="אין תהליך מכירה" description="כדי לנהל עסקאות צריך תהליך מכירה עם שלבים. מנהל המערכת יכול להוסיף אחד בהגדרות." />
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
        <nav aria-label="תהליכי מכירה" className="flex flex-wrap gap-2">
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
  // DEAL-09: owner ("me" or a user), team, tag and expected close date range, all from the address
  const idParam = (value: string | undefined) => (value && isUuid(value) ? value : null);
  const dayParam = (value: string | undefined) => (value && isCalendarDate(value) ? value : null);
  const ownerParam = firstParam(query.owner) === "me" ? "me" : idParam(firstParam(query.owner));
  const filter = {
    owner: ownerParam,
    ownerId: ownerParam === "me" ? context.user.id : ownerParam,
    teamId: idParam(firstParam(query.team)),
    tagId: idParam(firstParam(query.tag)),
    closeFrom: dayParam(firstParam(query.close_from)),
    closeTo: dayParam(firstParam(query.close_to)),
  };
  // DEAL-09: the user's card fields decide what the board reads
  const cardFieldsRead = getBoardFields(orgId);
  const [cardFields, board, pipelines, members, teams, tags, lossReasons] = await Promise.all([
    cardFieldsRead,
    cardFieldsRead.then((fields) => getBoard(orgId, requested, { showClosed, fullStage, filter, cardFields: fields.keys })),
    listPipelines(orgId),
    listMembers(orgId),
    listTeams(orgId),
    listTags(orgId),
    canWrite ? listLossReasons(orgId) : Promise.resolve([]),
  ]);

  if (!board) {
    return NO_PIPELINE;
  }

  const stuck = await getStuckDeals(orgId, board.pipeline.id);
  const openStages = board.stages.filter((stage) => stage.kind === "open");
  const openCount = openStages.reduce((sum, stage) => sum + (board.totals[stage.id]?.count ?? 0), 0);
  const openTotal = openStages.reduce((sum, stage) => sum + (board.totals[stage.id]?.amountAgorot ?? 0), 0);
  const anyDeals = Object.values(board.totals).some((t) => t.count > 0);
  // the board's address with one setting changed, keeping the others
  const boardHref = (change: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const current: Record<string, string | null> = {
      pipeline: requested ?? null,
      closed: showClosed ? "1" : null,
      stage: fullStage ?? null,
      owner: filter.owner,
      team: filter.teamId,
      tag: filter.tagId,
      close_from: filter.closeFrom,
      close_to: filter.closeTo,
      ...change,
    };
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
          anyDeals ? `תהליך המכירה "${board.pipeline.name}": ${formatNumber(openCount)} עסקאות פתוחות בשווי ${formatMoney(openTotal)}.` : `תהליך המכירה "${board.pipeline.name}"`
        }
        actions={newDealButton}
      />

      <ViewNav orgId={orgId} pipelineId={board.pipeline.id} pipelines={pipelines} table={false} />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <Link href={boardHref({ closed: showClosed ? null : "1" })} className="text-accent-strong underline underline-offset-4">
            {showClosed ? "הסתרת עסקאות שנסגרו" : "הצגת עסקאות שנסגרו (בהצלחה ואבודות)"}
          </Link>
        </p>
        <ColumnsPanel
          orgId={orgId}
          object={BOARD_PREFERENCE}
          catalog={cardFields.catalog}
          columns={cardFields.keys.map((key) => ({ key, width: "normal" }))}
          saved={cardFields.saved}
          widths={false}
          max={MAX_BOARD_FIELDS}
          texts={{
            button: "שדות בכרטיס",
            group: "בחירת השדות בכרטיס עסקה",
            hint: "שם העסקה תמיד מוצג. מסמנים מה להציג על כל כרטיס, ומסדרים בחצים.",
            save: "שמירת השדות",
          }}
        />
      </div>

      <BoardFilters
        action={paths.deals(orgId)}
        keep={Object.fromEntries(Object.entries({ pipeline: requested ?? null, closed: showClosed ? "1" : null }).filter((e): e is [string, string] => e[1] !== null))}
        filter={filter}
        owners={members.filter((m) => m.status === "active").map((m) => ({ value: m.userId, label: m.name }))}
        teams={teams.map((t) => ({ value: t.id, label: t.name }))}
        tags={tags.map((t) => ({ value: t.id, label: t.name }))}
        clearHref={filter.owner || filter.teamId || filter.tagId || filter.closeFrom || filter.closeTo ? boardHref({ owner: null, team: null, tag: null, close_from: null, close_to: null }) : null}
        timeZone={context.org.timeZone}
      />

      {!anyDeals && isBoardFiltered(filter) ? (
        <div className="mb-5 rounded-lg border border-line bg-surface">
          <EmptyState kind="search" title="אין עסקאות שמתאימות לסינון" description="נסו לשנות את הסינון או לנקות אותו." />
        </div>
      ) : !anyDeals ? (
        <div className="mb-5 rounded-lg border border-line bg-surface">
          <EmptyState icon={<BoardIcon />}
            title="עוד אין עסקאות"
            description="עסקה נוצרת כשממירים ליד, או ידנית מכאן. בלוח רואים בכל רגע כמה כסף נמצא בכל שלב."
            action={newDealButton}
          />
        </div>
      ) : null}

      {board.totalsPartial ? (
        <p className="mb-3 text-sm text-ink-soft" role="status">
          {`יותר מ-${formatNumber(FILTERED_TOTALS_LIMIT)} עסקאות מתאימות לסינון. הסכומים מחושבים מ-${formatNumber(FILTERED_TOTALS_LIMIT)} הראשונות בלבד. צמצמו את הסינון כדי לקבל סכום מדויק.`}
        </p>
      ) : null}

      <DealsBoard
        orgId={orgId}
        board={board}
        canWrite={canWrite}
        stuck={stuck}
        lossReasons={activeLossReasons(lossReasons)}
        cardFields={cardFields.keys}
        lookups={{
          owners: Object.fromEntries(members.map((m) => [m.userId, m.name])),
          tags: Object.fromEntries(tags.map((t) => [t.id, t.name])),
          fields: cardFields.fields.filter((field) => cardFields.keys.includes(`${CUSTOM_PREFIX}${field.key}`)),
        }}
        closeWindow={
          canWrite
            ? closeWindowSetup(
                members.filter((m) => m.status === "active" && m.role !== "viewer").map((m) => ({ value: m.userId, label: m.name })),
                context.org.timeZone,
              )
            : null
        }
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

  const [editing, tags, viewData, { deals, hasMore }, lossReasons] = await Promise.all([
    inlineEditing(orgId, context),
    listTags(orgId),
    viewChips(orgId, "deal", context),
    listDeals(orgId, { pipelineId: pipeline.id, search, tagId, page, sort, filter: filter.logic }),
    context.canWrite ? listLossReasons(orgId) : Promise.resolve([]),
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
      <PageHeader title="עסקאות" description={`תהליך המכירה "${pipeline.name}"`} actions={newDealButton} />
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
          lossReasons={activeLossReasons(lossReasons).map((reason) => reason.name)}
          closeWindow={context.canWrite ? closeWindowSetup(editing.owners, context.org.timeZone) : null}
        />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {isFiltered || page > 1 ? (
            <EmptyState kind="search"
              title="לא נמצאו עסקאות"
              description="אין עסקאות שמתאימות לחיפוש או לסינון. נסו מילה אחרת או נקו את הסינון."
              action={
                <ButtonLink href={`${paths.deals(orgId)}?view=table${pipelineParam ? `&pipeline=${pipelineParam}` : ""}`} variant="secondary">
                  ניקוי הסינון
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState icon={<BoardIcon />} title="עוד אין עסקאות בתהליך המכירה הזה" description="עסקה נוצרת כשממירים ליד, או ידנית מכאן." action={newDealButton} />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}

import type { Metadata } from "next";
import Form from "next/form";

import { Pagination } from "@/components/pagination";
import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { CompaniesTable } from "@/features/companies/components/companies-table";
import { COMPANY_DEFAULT_SORT, COMPANY_SORT_COLUMNS, listCompanies } from "@/features/companies/queries";
import { CUSTOM_PREFIX, resolveColumns } from "@/features/list-columns/columns";
import { ColumnsPanel } from "@/features/list-columns/components/columns-panel";
import { getListColumns } from "@/features/list-columns/queries";
import { getOrgContext } from "@/features/shell/queries";
import { listTags } from "@/features/tags/queries";
import { SavedViewsBar } from "@/features/views/components/saved-views-bar";
import { viewChips } from "@/features/views/server";
import { isUuid, paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";
import { nextSort, parseSort, sortValue, type CustomSortKey, type Sort } from "@/lib/sort";

export const metadata: Metadata = { title: "חברות" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function CompaniesPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const { canWrite } = context;

  const search = firstParam(query.q).trim();
  const tagParam = firstParam(query.tag);
  const tagId = isUuid(tagParam) ? tagParam : null;
  const page = parsePage(query.page);
  const listColumns = await getListColumns(orgId, "company");
  // any column the list can show sorts, custom fields included (LST-02, LST-03)
  const sortKeys = [...Object.keys(COMPANY_SORT_COLUMNS), ...listColumns.fields.map((f) => `${CUSTOM_PREFIX}${f.key}`)] as Array<keyof typeof COMPANY_SORT_COLUMNS | CustomSortKey>;
  const sort = parseSort(firstParam(query.sort), sortKeys, COMPANY_DEFAULT_SORT as Sort<(typeof sortKeys)[number]>);
  const [tags, viewData, { companies, hasMore }] = await Promise.all([
    listTags(orgId),
    viewChips(orgId, "company", context),
    listCompanies(orgId, { search, tagId, page, sort }),
  ]);

  const views = viewData.chips;
  // a saved view in use (LST-04): its columns replace the user's own while it is open
  const activeView = views.find((view) => view.id === firstParam(query.sv)) ?? null;
  const shownColumns = activeView?.config.columns ? resolveColumns("company", activeView.config.columns, listColumns.catalog) : listColumns.columns;

  const listHref = (target: number, sortParam: string) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (tagId) next.set("tag", tagId);
    if (sortParam !== sortValue(COMPANY_DEFAULT_SORT)) next.set("sort", sortParam);
    if (activeView) next.set("sv", activeView.id);
    if (target > 1) next.set("page", String(target));
    const suffix = next.toString();
    return suffix ? `${paths.companies(orgId)}?${suffix}` : paths.companies(orgId);
  };
  const hrefFor = (target: number) => listHref(target, sortValue(sort));
  // a new sort starts again from the first page; dates start with the newest
  const sortHref = (key: string) => listHref(1, sortValue(nextSort(sort, key as (typeof sortKeys)[number], key !== "created")));

  const newCompanyButton = canWrite ? (
    <ButtonLink href={paths.companyNew(orgId)}>
      <PlusIcon className="size-4.5" />
      חברה חדשה
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader title="חברות" description="הארגונים שהעסק עובד איתם, ואנשי הקשר והעסקאות של כל אחד." actions={newCompanyButton} />

      <SavedViewsBar
        orgId={orgId}
        objectType="company"
        listPath={paths.companies(orgId)}
        views={views}
        activeViewId={activeView?.id ?? null}
        current={{ q: search || undefined, tag: tagId ?? undefined }}
        currentSort={sortValue(sort)}
        currentColumns={shownColumns}
        teams={viewData.teams}
        canSave={context.role !== "viewer"}
        canShare={context.role === "owner" || context.role === "admin"}
      />

      <div className="mb-3 flex justify-end">
        {activeView?.config.columns ? (
          <p className="py-2 text-sm text-ink-soft">העמודות לפי התצוגה &quot;{activeView.name}&quot;</p>
        ) : (
          <ColumnsPanel orgId={orgId} object="company" catalog={listColumns.catalog} columns={listColumns.columns} saved={listColumns.saved} />
        )}
      </div>
      <Form action={paths.companies(orgId)} role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <TextField
          label="חיפוש חברות"
          hideLabel
          name="q"
          type="search"
          placeholder="חיפוש לפי שם, ח.פ., עיר או טלפון"
          defaultValue={search}
          className="min-w-0 flex-[1_1_14rem] sm:max-w-md"
        />
        {tags.length > 0 ? (
          <SelectField label="תגית" hideLabel name="tag" defaultValue={tagId ?? ""} className="flex-[1_1_9rem] sm:max-w-52">
            <option value="">כל התגיות</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        <button type="submit" className={buttonClasses("secondary")}>
          <SearchIcon className="size-4.5" />
          חיפוש
        </button>
      </Form>

      {companies.length > 0 ? (
        <CompaniesTable
          orgId={orgId}
          companies={companies}
          columns={shownColumns}
          catalog={listColumns.catalog}
          fields={listColumns.fields}
          sort={sort}
          sortHref={sortHref}
        />
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {search !== "" || tagId !== null || page > 1 ? (
            <EmptyState
              title="לא נמצאו חברות"
              description="אין חברות שמתאימות לחיפוש. נסו מילה אחרת."
              action={
                <ButtonLink href={paths.companies(orgId)} variant="secondary">
                  ניקוי החיפוש
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState
              title="עוד אין חברות"
              description="חברה נוצרת כשממירים ליד עם שם חברה, או ידנית מכאן."
              action={newCompanyButton}
            />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}

import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";

import { ButtonLink, buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { PlusIcon, SearchIcon, TagIcon } from "@/components/ui/icons";
import { PageHeader } from "@/components/ui/page-header";
import { Pagination } from "@/components/ui/pagination";
import { ExportMenu, exportHref } from "@/features/list-export/components/export-menu";
import { priceListsPath } from "@/features/price-lists/paths";
import { ProductsTable, ProductStatusBadge } from "@/features/products/components/products-table";
import { billingSuffix, productPriceText } from "@/features/products/display";
import { listProductCategories, listProductUnits } from "@/features/products/list-queries";
import { categoryLabel, categoryOptions, categoryWithChildren } from "@/features/products/lists";
import { productNewPath, productPath, productsPath } from "@/features/products/paths";
import {
  listProducts,
  PRODUCT_DEFAULT_SORT,
  PRODUCT_SORT_COLUMNS,
  PRODUCT_STATUS_FILTERS,
  type ProductSortKey,
  type ProductStatusFilter,
} from "@/features/products/queries";
import { PRODUCT_KIND_LABELS, PRODUCT_KINDS, type ProductKind } from "@/features/products/schema";
import { canExport } from "@/features/reports/request";
import { isAdminRole } from "@/features/settings/permissions";
import { orgHasFeature } from "@/features/settings/queries";
import { getOrgContext } from "@/features/shell/queries";
import { isUuid, paths } from "@/lib/paths";
import { firstParam, parsePage } from "@/lib/search";
import { nextSort, parseSort, sortValue } from "@/lib/sort";

export const metadata: Metadata = { title: "מוצרים" };

type Props = {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const STATUS_LABELS: Record<Exclude<ProductStatusFilter, "">, string> = { active: "פעילים", inactive: "לא פעילים", archived: "בארכיון" };

/** PRD-01: the organization's catalog of products and services. Everyone reads it; owners and admins edit. */
export default async function ProductsPage({ params, searchParams }: Props) {
  const { orgId } = await params;
  const query = await searchParams;
  const context = await getOrgContext(orgId);
  const canEdit = isAdminRole(context.role) && context.canWrite;

  const search = firstParam(query.q).trim();
  const categoryParam = firstParam(query.category);
  const kindParam = firstParam(query.kind);
  const statusParam = firstParam(query.status);
  const kind = (PRODUCT_KINDS as readonly string[]).includes(kindParam) ? (kindParam as ProductKind) : null;
  const status: ProductStatusFilter = (PRODUCT_STATUS_FILTERS as readonly string[]).includes(statusParam) ? (statusParam as ProductStatusFilter) : "";
  const page = parsePage(query.page);
  const sort = parseSort(firstParam(query.sort), Object.keys(PRODUCT_SORT_COLUMNS) as ProductSortKey[], PRODUCT_DEFAULT_SORT);

  const [categories, units, hasPriceLists] = await Promise.all([
    listProductCategories(orgId),
    listProductUnits(orgId),
    orgHasFeature(orgId, "price_lists"),
  ]);
  const categoryId = isUuid(categoryParam) && categories.some((c) => c.id === categoryParam) ? categoryParam : null;
  const { products, hasMore } = await listProducts(orgId, {
    search,
    categoryIds: categoryId ? categoryWithChildren(categories, categoryId) : null,
    kind,
    status,
    page,
    sort,
  });

  const categoryLabels = new Map(categories.map((c) => [c.id, categoryLabel(categories, c.id) ?? c.name]));
  const unitNames = new Map(units.map((u) => [u.id, u.name]));

  const listHref = (target: number, sortParam: string) => {
    const next = new URLSearchParams();
    if (search) next.set("q", search);
    if (categoryId) next.set("category", categoryId);
    if (kind) next.set("kind", kind);
    if (status) next.set("status", status);
    if (sortParam !== sortValue(PRODUCT_DEFAULT_SORT)) next.set("sort", sortParam);
    if (target > 1) next.set("page", String(target));
    const suffix = next.toString();
    return suffix ? `${productsPath(orgId)}?${suffix}` : productsPath(orgId);
  };
  const hrefFor = (target: number) => listHref(target, sortValue(sort));
  // a new sort starts again from the first page; dates and prices start with the highest
  const sortHref = (key: string) => listHref(1, sortValue(nextSort(sort, key as ProductSortKey, key !== "created" && key !== "price")));
  const filtered = search !== "" || categoryId !== null || kind !== null || status !== "" || page > 1;

  const newButton = canEdit ? (
    <ButtonLink href={productNewPath(orgId)}>
      <PlusIcon className="size-4.5" />
      מוצר חדש
    </ButtonLink>
  ) : null;

  return (
    <>
      <PageHeader
        title="מוצרים"
        description="המוצרים והשירותים שהעסק מוכר, עם המחיר, היחידה והמע״מ של כל אחד."
        actions={
          <>
            {/* PL-01: the further price lists, readable by everyone, when the plan holds them */}
            {hasPriceLists ? (
              <ButtonLink href={priceListsPath(orgId)} variant="ghost">
                מחירונים
              </ButtonLink>
            ) : null}
            {newButton || canExport(context.role) ? (
              <>
              {/* PRD-05: export with the list's filters; import through the import wizard */}
              {canExport(context.role) ? <ExportMenu href={exportHref(productsPath(orgId), listHref(1, sortValue(sort)))} /> : null}
              {canEdit ? (
                <ButtonLink href={`${paths.importNew(orgId)}?entity=product`} variant="secondary">
                  ייבוא
                </ButtonLink>
              ) : null}
              {newButton}
              </>
            ) : null}
          </>
        }
      />

      <Form action={productsPath(orgId)} role="search" className="mb-4 flex flex-wrap items-end gap-2">
        <TextField
          label="חיפוש מוצרים"
          hideLabel
          name="q"
          type="search"
          placeholder='חיפוש לפי שם, מק"ט או ברקוד'
          defaultValue={search}
          className="min-w-0 flex-[1_1_14rem] sm:max-w-md"
        />
        {categories.length > 0 ? (
          <SelectField label="קטגוריה" hideLabel name="category" defaultValue={categoryId ?? ""} className="flex-[1_1_9rem] sm:max-w-56">
            <option value="">כל הקטגוריות</option>
            {categoryOptions(categories).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </SelectField>
        ) : null}
        <SelectField label="סוג" hideLabel name="kind" defaultValue={kind ?? ""} className="flex-[1_1_8rem] sm:max-w-44">
          <option value="">כל הסוגים</option>
          {PRODUCT_KINDS.map((value) => (
            <option key={value} value={value}>
              {PRODUCT_KIND_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <SelectField label="מצב" hideLabel name="status" defaultValue={status} className="flex-[1_1_8rem] sm:max-w-44">
          <option value="">פעילים ולא פעילים</option>
          {PRODUCT_STATUS_FILTERS.map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <button type="submit" className={buttonClasses("secondary")}>
          <SearchIcon className="size-4.5" />
          חיפוש
        </button>
      </Form>

      {products.length > 0 ? (
        <>
          <ul aria-label="מוצרים" className="md:hidden">
            {products.map((product) => {
              const suffix = billingSuffix(product.billing);
              return (
                <li key={product.id} className="mb-2 rounded-lg border border-line bg-surface">
                  <Link href={productPath(orgId, product.id)} className="block px-4 py-3">
                    <span className="block font-medium break-words text-ink">{product.name}</span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-soft">
                      <ProductStatusBadge product={product} />
                      <span>{PRODUCT_KIND_LABELS[product.kind]}</span>
                      <span>
                        {productPriceText(product)}
                        {suffix ? ` · ${suffix}` : ""}
                      </span>
                      {product.categoryId && categoryLabels.get(product.categoryId) ? <span>{categoryLabels.get(product.categoryId)}</span> : null}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          <div className="hidden md:block">
            <ProductsTable orgId={orgId} products={products} categoryLabels={categoryLabels} unitNames={unitNames} sort={sort} sortHref={sortHref} />
          </div>
        </>
      ) : (
        <div className="rounded-lg border border-line bg-surface">
          {filtered ? (
            <EmptyState
              kind="search"
              title="לא נמצאו מוצרים"
              description="אין מוצרים שמתאימים לחיפוש או לסינון. מוצרים בארכיון מופיעים רק כשבוחרים &quot;בארכיון&quot;."
              action={
                <ButtonLink href={productsPath(orgId)} variant="secondary">
                  ניקוי הסינון
                </ButtonLink>
              }
            />
          ) : (
            <EmptyState
              icon={<TagIcon />}
              title="עוד אין מוצרים"
              description={canEdit ? "מוסיפים כאן את המוצרים והשירותים של העסק, ומהם בונים אחר כך הצעות מחיר." : "בעלי העסק ומנהלי המערכת מוסיפים כאן את המוצרים והשירותים."}
              action={newButton}
            />
          )}
        </div>
      )}

      <Pagination page={page} hasMore={hasMore} hrefFor={hrefFor} />
    </>
  );
}

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { BulkSelection, RowCheck } from "@/features/bulk/components/bulk-selection";
import { InlineEdit } from "@/features/inline-edit/components/inline-edit";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import { formatDate } from "@/lib/format";
import type { Sort } from "@/lib/sort";

import { billingSuffix, productPriceText } from "../display";
import { productPath } from "../paths";
import type { Product } from "../queries";
import { PRODUCT_KIND_LABELS, VAT_KIND_LABELS } from "../schema";

export function ProductStatusBadge({ product }: { product: Pick<Product, "isActive" | "archivedAt"> }) {
  if (product.archivedAt) return <Badge>בארכיון</Badge>;
  return product.isActive ? <Badge tone="success">פעיל</Badge> : <Badge tone="warning">לא פעיל</Badge>;
}

// the states a product can be put in from the list (bulk "שינוי מצב")
const STATUS_OPTIONS = [
  { value: "active", label: "פעיל" },
  { value: "inactive", label: "לא פעיל" },
  { value: "archived", label: "בארכיון" },
];

type Option = { value: string; label: string };

type Props = {
  orgId: string;
  products: Product[];
  columns: ColumnChoice[];
  catalog: CatalogColumn[];
  categoryLabels: Map<string, string>;
  // the category picker's choices, in tree order
  categories: Option[];
  unitNames: Map<string, string>;
  sort: Sort<string>;
  sortHref: (key: string) => string;
  // catalog editors (owners, admins, PRM-01 grant) of a writable business: editing in the cell and bulk changes
  canEdit: boolean;
  // the export route for "export the picked rows"; null when the user may not export
  exportPath: string | null;
};

/**
 * The product catalog as a table (PRD-01, LST-09): the user's columns, sorting, editing the name and the
 * category in the cell, and bulk actions (state, category, export), as in the other lists. The products
 * policies decide every change; the pencils and checkboxes are hints for who may.
 */
export function ProductsTable({ orgId, products, columns, catalog, categoryLabels, categories, unitNames, sort, sortHref, canEdit, exportPath }: Props) {
  return (
    <BulkSelection
      orgId={orgId}
      object="product"
      ids={products.map((product) => product.id)}
      owners={null}
      statuses={canEdit ? STATUS_OPTIONS : null}
      categories={canEdit ? categories : null}
      tags={[]}
      canTrash={false}
      exportPath={exportPath}
      enabled={canEdit || exportPath !== null}
    >
      <ListTable
        label="מוצרים"
        rows={products}
        rowKey={(product) => product.id}
        nameCell={(product) => (
          <div className="flex items-start gap-2">
            <RowCheck id={product.id} label={product.name} />
            <div className="min-w-0">
              <InlineEdit
                orgId={orgId}
                object="product"
                id={product.id}
                field="name"
                kind="text"
                label={`שם: ${product.name}`}
                initial={{ text: product.name }}
                canEdit={canEdit}
              >
                <Link href={productPath(orgId, product.id)} className="font-medium text-accent-strong underline-offset-4 hover:underline">
                  {product.name}
                </Link>
              </InlineEdit>
            </div>
          </div>
        )}
        columns={columns}
        catalog={catalog}
        fields={[]}
        customValues={() => ({})}
        sort={sort}
        sortHref={sortHref}
        cell={(key, product) => {
          switch (key) {
            case "sku":
              return product.sku ? <span dir="ltr">{product.sku}</span> : null;
            case "barcode":
              return product.barcode ? <span dir="ltr">{product.barcode}</span> : null;
            case "category":
              return (
                <InlineEdit
                  orgId={orgId}
                  object="product"
                  id={product.id}
                  field="category"
                  kind="select"
                  label={`קטגוריה: ${product.name}`}
                  initial={{ id: product.categoryId }}
                  options={categories}
                  emptyOption="ללא קטגוריה"
                  canEdit={canEdit}
                >
                  {product.categoryId ? (categoryLabels.get(product.categoryId) ?? null) : null}
                </InlineEdit>
              );
            case "kind":
              return PRODUCT_KIND_LABELS[product.kind];
            case "price": {
              const suffix = billingSuffix(product.billing);
              return (
                <span className="whitespace-nowrap">
                  {productPriceText(product)}
                  {suffix ? <span className="text-ink-soft"> · {suffix}</span> : null}
                </span>
              );
            }
            case "unit":
              return product.unitId ? (unitNames.get(product.unitId) ?? null) : null;
            case "vat":
              return VAT_KIND_LABELS[product.vatKind];
            case "status":
              return <ProductStatusBadge product={product} />;
            case "created":
              return (
                <time dateTime={product.createdAt} className="whitespace-nowrap text-ink-soft">
                  {formatDate(product.createdAt)}
                </time>
              );
            default:
              return null;
          }
        }}
      />
    </BulkSelection>
  );
}

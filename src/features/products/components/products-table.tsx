import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { ListTable } from "@/features/list-columns/components/list-table";
import type { CatalogColumn, ColumnChoice } from "@/features/list-columns/columns";
import type { Sort } from "@/lib/sort";

import { billingSuffix, productPriceText } from "../display";
import { productPath } from "../paths";
import type { Product } from "../queries";
import { PRODUCT_KIND_LABELS, VAT_KIND_LABELS } from "../schema";

// the catalog's columns; the name column comes first and is not listed
export const PRODUCT_CATALOG: CatalogColumn[] = [
  { key: "sku", label: 'מק"ט' },
  { key: "category", label: "קטגוריה" },
  { key: "kind", label: "סוג" },
  { key: "price", label: "מחיר" },
  { key: "unit", label: "יחידה" },
  { key: "vat", label: 'מע"מ' },
  { key: "status", label: "מצב" },
];
const COLUMNS: ColumnChoice[] = PRODUCT_CATALOG.map((column) => ({ key: column.key, width: column.key === "price" ? "wide" : "normal" }));

export function ProductStatusBadge({ product }: { product: Pick<Product, "isActive" | "archivedAt"> }) {
  if (product.archivedAt) return <Badge>בארכיון</Badge>;
  return product.isActive ? <Badge tone="success">פעיל</Badge> : <Badge tone="warning">לא פעיל</Badge>;
}

type Props = {
  orgId: string;
  products: Product[];
  categoryLabels: Map<string, string>;
  unitNames: Map<string, string>;
  sort: Sort<string>;
  sortHref: (key: string) => string;
};

/** The product catalog as a table (PRD-01). */
export function ProductsTable({ orgId, products, categoryLabels, unitNames, sort, sortHref }: Props) {
  return (
    <ListTable
      label="מוצרים"
      rows={products}
      rowKey={(product) => product.id}
      nameCell={(product) => (
        <Link href={productPath(orgId, product.id)} className="font-medium text-accent-strong underline-offset-4 hover:underline">
          {product.name}
        </Link>
      )}
      columns={COLUMNS}
      catalog={PRODUCT_CATALOG}
      fields={[]}
      customValues={() => ({})}
      sort={sort}
      sortHref={sortHref}
      cell={(key, product) => {
        switch (key) {
          case "sku":
            return product.sku ? <span dir="ltr">{product.sku}</span> : null;
          case "category":
            return product.categoryId ? (categoryLabels.get(product.categoryId) ?? null) : null;
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
          default:
            return null;
        }
      }}
    />
  );
}

import type { ReactNode } from "react";

import { formatDateTime } from "@/lib/format";

import { billingSuffix, productPriceText } from "../display";
import type { Product } from "../queries";
import { BILLING_LABELS, PRODUCT_KIND_LABELS, VAT_KIND_LABELS } from "../schema";
import { ProductStatusBadge } from "./products-table";

type Props = { product: Product; categoryText: string | null; unitName: string | null };

/** A product's details, read only (PRD-01): what every member sees. */
export function ProductDetails({ product, categoryText, unitName }: Props) {
  const suffix = billingSuffix(product.billing);
  const rows: Array<[string, ReactNode]> = [
    ["מצב", <ProductStatusBadge key="status" product={product} />],
    ["סוג", PRODUCT_KIND_LABELS[product.kind]],
    ["מחיר", `${productPriceText(product)}${suffix ? ` · ${suffix}` : ""}`],
    ["חיוב", BILLING_LABELS[product.billing]],
    ['מע"מ', VAT_KIND_LABELS[product.vatKind]],
    ["יחידת מידה", unitName ?? "—"],
    ["קטגוריה", categoryText ?? "—"],
    ['מק"ט', product.sku ? <span dir="ltr">{product.sku}</span> : "—"],
    ["ברקוד", product.barcode ? <span dir="ltr">{product.barcode}</span> : "—"],
  ];
  if (product.kind === "service" || product.durationMinutes !== null) {
    rows.push(["משך", product.durationMinutes ? `${product.durationMinutes} דקות` : "—"]);
  }
  if (product.archivedAt) rows.push(["הועבר לארכיון", formatDateTime(product.archivedAt)]);

  return (
    <div className="space-y-4">
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-sm text-ink-soft">{label}</dt>
            <dd className="mt-0.5 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {product.description ? (
        <div>
          <h3 className="text-sm text-ink-soft">תיאור</h3>
          <p className="mt-0.5 whitespace-pre-line break-words">{product.description}</p>
        </div>
      ) : null}
    </div>
  );
}

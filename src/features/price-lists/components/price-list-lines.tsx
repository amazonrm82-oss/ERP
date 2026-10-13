import Link from "next/link";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { productPath } from "@/features/products/paths";

import { deletePriceListLineAction } from "../actions";
import { percentText, tierText, unitPriceText } from "../display";
import { discountedPrice } from "../price";
import type { PriceListLine, PricingProduct } from "../queries";

type Props = {
  orgId: string;
  listId: string;
  lines: PriceListLine[];
  products: Map<string, PricingProduct>;
  editable: boolean;
};

/** The prices of one price list (PL-02), grouped by product, each product's tiers by quantity. */
export function PriceListLines({ orgId, listId, lines, products, editable }: Props) {
  const groups = new Map<string, PriceListLine[]>();
  for (const line of lines) {
    const group = groups.get(line.productId);
    if (group) group.push(line);
    else groups.set(line.productId, [line]);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => (products.get(a)?.name ?? "").localeCompare(products.get(b)?.name ?? "", "he"));

  return (
    <ul>
      {ordered.map(([productId, tiers]) => {
        const product = products.get(productId);
        if (!product) return null;
        const own = unitPriceText(product, product.vatKind);
        return (
          <li key={productId} className="border-b border-line px-4 py-3 last:border-b-0 sm:px-5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link href={productPath(orgId, product.id)} className="font-medium break-words text-ink underline-offset-2 hover:underline">
                {product.name}
              </Link>
              {product.archivedAt ? <Badge>בארכיון</Badge> : !product.isActive ? <Badge tone="warning">לא פעיל</Badge> : null}
            </p>
            <p className="mt-0.5 text-sm text-ink-soft">המחיר במוצר: {own}</p>
            <ul className="mt-2 space-y-1.5">
              {[...tiers]
                .sort((a, b) => a.minQuantity - b.minQuantity)
                .map((line) => {
                  const price =
                    line.priceAgorot !== null
                      ? { priceAgorot: line.priceAgorot, priceIncludesVat: line.priceIncludesVat }
                      : { priceAgorot: discountedPrice(product.priceAgorot, line.discountBp ?? 0), priceIncludesVat: product.priceIncludesVat };
                  const label = tierText(line.minQuantity);
                  return (
                    <li key={line.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-md bg-canvas px-3 py-2">
                      <span className="min-w-0 text-md">
                        <span className="font-medium text-ink">{label}</span>
                        <span className="text-ink-soft"> · </span>
                        {line.discountBp !== null ? (
                          <span className="text-ink">
                            הנחה {percentText(line.discountBp)} <span className="text-ink-soft">({unitPriceText(price, product.vatKind)})</span>
                          </span>
                        ) : (
                          <span className="text-ink">{unitPriceText(price, product.vatKind)}</span>
                        )}
                      </span>
                      {editable ? (
                        <ActionButton
                          action={deletePriceListLineAction.bind(null, orgId, listId, line.id)}
                          pendingText="מסירים…"
                          variant="danger-ghost"
                          srLabel={`${product.name}, ${label}`}
                        >
                          הסרה
                        </ActionButton>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}

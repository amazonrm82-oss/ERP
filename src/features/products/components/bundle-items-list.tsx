import { formatNumber } from "@/lib/format";

import { partQuantity, type BundlePartSnapshot } from "../bundle";

/**
 * PRD-09: the parts of an itemised bundle line, under the line: name and quantity (per bundle x the line's quantity), no
 * prices of their own. Used on the deal, the quote and order screens, their documents and the customer's pages.
 */
export function BundleItemsList({ parts, lineQuantity, className }: { parts: BundlePartSnapshot[]; lineQuantity: number; className?: string }) {
  if (parts.length === 0) return null;
  return (
    <ul aria-label="רכיבי החבילה" className={className ?? "mt-1 space-y-0.5 text-sm text-ink-soft"}>
      {parts.map((part, index) => (
        <li key={index} className="flex gap-1.5">
          <span aria-hidden="true">·</span>
          <span>
            <span dir="ltr" className="tabular-nums">
              {formatNumber(partQuantity(part.quantity, lineQuantity))}
            </span>
            {part.unitName ? ` ${part.unitName}` : ""} <bdi>{part.name}</bdi>
          </span>
        </li>
      ))}
    </ul>
  );
}

import { formatDateTime } from "@/lib/format";

import type { PriceChange } from "../price-history";

/** PRD-07: the product's price changes, newest first: when, who, and the price before and after. */
export function PriceHistory({ changes }: { changes: PriceChange[] }) {
  if (changes.length === 0) {
    return <p className="text-sm text-ink-soft">המחיר לא השתנה מאז שהמוצר נוצר.</p>;
  }
  return (
    <ol className="divide-y divide-line">
      {changes.map((change) => (
        <li key={change.id} className="py-2.5 first:pt-0 last:pb-0">
          <p className="break-words">
            <span>{change.before}</span>
            <span className="text-ink-soft" aria-label="שונה ל"> ← </span>
            <span className="font-medium">{change.after}</span>
          </p>
          <p className="mt-0.5 text-sm text-ink-soft">
            <time dateTime={change.createdAt}>{formatDateTime(change.createdAt)}</time>
            {" · "}
            {change.actorName ?? "המערכת"}
          </p>
        </li>
      ))}
    </ol>
  );
}

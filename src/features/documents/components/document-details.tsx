import { formatMoney } from "@/lib/format";

import type { AccountingDocument, DocumentLine } from "../queries";

/** DOC-02: the details printed on a document (allocation number, VAT split, source, original), one short line; nothing when empty. */
export function DocumentDetailsLine({ doc, quoteLabel, originalLabel }: { doc: AccountingDocument; quoteLabel: string | null; originalLabel: string | null }) {
  const parts: React.ReactNode[] = [];
  if (doc.allocationNumber) {
    parts.push(
      <span key="allocation">
        מספר הקצאה{" "}
        <bdi dir="ltr" className="tabular-nums">
          {doc.allocationNumber}
        </bdi>
      </span>,
    );
  }
  if (doc.netAgorot !== null && doc.vatAgorot !== null) {
    parts.push(
      <span key="vat">
        לפני מע&quot;מ <span className="tabular-nums">{formatMoney(doc.netAgorot)}</span>, מע&quot;מ <span className="tabular-nums">{formatMoney(doc.vatAgorot)}</span>
        {doc.vatRateBp !== null ? ` (${(doc.vatRateBp / 100).toLocaleString("he-IL")}%)` : ""}
      </span>,
    );
  }
  if (doc.quoteId) parts.push(<span key="quote">{quoteLabel ? <>הופק מ<bdi>{quoteLabel}</bdi></> : "הופק מהצעת מחיר"}</span>);
  if (doc.originalDocumentId) parts.push(<span key="original">{originalLabel ? <>מזכה את {originalLabel}</> : "מזכה מסמך קודם"}</span>);
  if (parts.length === 0) return null;
  return (
    <p className="text-sm break-words text-ink-soft">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : ""}
          {part}
        </span>
      ))}
    </p>
  );
}

/** DOC-02: the document's lines, folded away (a list, readable at 360px). */
export function DocumentLinesList({ lines }: { lines: DocumentLine[] }) {
  if (lines.length === 0) return null;
  return (
    <details className="mt-1 text-sm">
      <summary className="cursor-pointer text-accent-strong">{lines.length === 1 ? "שורה אחת" : `${lines.length.toLocaleString("he-IL")} שורות`}</summary>
      <ol className="mt-1 space-y-1">
        {lines.map((line) => (
          <li key={line.position} className="flex flex-wrap justify-between gap-x-3">
            <span className="min-w-0 break-words">
              <bdi>{line.description}</bdi>
              <span className="text-ink-soft">
                {" · "}
                <span className="tabular-nums">{line.quantity.toLocaleString("he-IL")}</span> × <span className="tabular-nums">{formatMoney(line.unitPriceAgorot)}</span>
                {line.discountAgorot > 0 ? <> · הנחה <span className="tabular-nums">{formatMoney(line.discountAgorot)}</span></> : null}
                {line.vatExempt ? ' · פטור ממע"מ' : ""}
              </span>
            </span>
            <span className="font-medium whitespace-nowrap tabular-nums">{formatMoney(line.totalAgorot)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}

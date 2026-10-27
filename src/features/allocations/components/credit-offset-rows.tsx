import { documentTitle } from "@/features/documents/schema";
import { formatMoney } from "@/lib/format";

import type { CreditOffset } from "../queries";

/**
 * GAP-12 (owner's answer (2) א): the offsets of an opening credit on one document: on a negative opening balance, the
 * documents it was offset against; on any other document, the opening credits offset against it. Released and undone ones
 * are struck through.
 */
export function CreditOffsetRows({ documentId, offsets }: { documentId: string; offsets: CreditOffset[] }) {
  const mine = offsets.filter((o) => o.documentId === documentId || o.creditDocumentId === documentId);
  if (mine.length === 0) return null;
  return (
    <ul className="mt-1 space-y-1 text-sm">
      {mine.map((o) => {
        const fromCredit = o.creditDocumentId === documentId;
        const other = fromCredit ? o.document : o.credit;
        const title = other ? documentTitle(other) : "מסמך";
        return (
          <li key={o.id} className={o.counted ? "" : "text-ink-soft line-through"}>
            {fromCredit ? "קוזז ל" : "קוזז מ"}
            <bdi>{title}</bdi>: <span className="tabular-nums">{formatMoney(o.amountAgorot)}</span>
            {o.released ? <span className="text-ink-soft"> (שוחרר כי אחד המסמכים בוטל)</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

import { formatDate, formatMoney } from "@/lib/format";

import { payStateText, type PublicDocument } from "../public";

const day = (iso: string | null) => (iso ? formatDate(`${iso}T12:00:00Z`) : "");
const quantityText = (q: number) => (Number.isInteger(q) ? String(q) : q.toLocaleString("he-IL", { maximumFractionDigits: 3 }));
const rateText = (bp: number) => `${(bp / 100).toLocaleString("he-IL", { maximumFractionDigits: 2 })}%`;

/**
 * DOC-15: the body of the customer's document page: the dates, the allocation number, the pay state, the lines as recorded
 * (a table on a wide page and on paper, cards on a phone) and the totals. Only what public.document_public answered; the
 * page around it draws the family header and footer.
 */
export function DocumentView({ doc }: { doc: Extract<PublicDocument, { kind: "document" }> }) {
  const state = payStateText(doc);
  const owes = (doc.payState === "unpaid" || doc.payState === "partial") && (doc.balanceAgorot ?? 0) > 0;
  return (
    <article aria-label={doc.title} className="space-y-5 rounded-lg border border-line bg-surface p-4 text-ink sm:p-6 print:border-0 print:p-0">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-ink-soft">תאריך:</dt>
          <dd>{day(doc.docDate)}</dd>
        </div>
        {doc.dueDate ? (
          <div className="flex gap-2">
            <dt className="text-ink-soft">לתשלום עד:</dt>
            <dd>{day(doc.dueDate)}</dd>
          </div>
        ) : null}
        {doc.allocationNumber ? (
          <div className="flex gap-2">
            <dt className="text-ink-soft">מספר הקצאה:</dt>
            <dd dir="ltr" className="tabular-nums">
              {doc.allocationNumber}
            </dd>
          </div>
        ) : null}
        {state ? (
          <div className="flex gap-2">
            <dt className="text-ink-soft">מצב תשלום:</dt>
            <dd className={doc.overdueDays > 0 && owes ? "font-medium text-danger" : "font-medium"}>{state}</dd>
          </div>
        ) : null}
      </dl>

      {doc.lines.length > 0 ? (
        <section aria-labelledby="document-lines" className="space-y-2">
          <h2 id="document-lines" className="text-md font-semibold">
            פירוט
          </h2>
          <ul className="space-y-2 sm:hidden print:hidden">
            {doc.lines.map((line) => (
              <li key={line.key} className="space-y-1 rounded-md border border-line p-3 text-sm">
                <p className="font-medium break-words">{line.description}</p>
                <p className="flex flex-wrap justify-between gap-2 text-ink-soft">
                  <span>
                    {quantityText(line.quantity)} × {formatMoney(line.unitPriceAgorot)}
                    {line.discountAgorot > 0 ? ` · הנחה ${formatMoney(line.discountAgorot)}` : ""}
                    {line.vatExempt ? " · פטור ממע״מ" : ""}
                  </span>
                  <span className="font-semibold text-ink tabular-nums">{formatMoney(line.totalAgorot)}</span>
                </p>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto sm:block print:block" role="region" aria-labelledby="document-lines" tabIndex={0}>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th scope="col" className="px-2 py-2 text-start font-medium">
                    תיאור
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-medium">
                    כמות
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-medium">
                    מחיר ליחידה
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-medium">
                    הנחה
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-medium">
                    סה״כ
                  </th>
                </tr>
              </thead>
              <tbody>
                {doc.lines.map((line) => (
                  <tr key={line.key} className="border-b border-line">
                    <td className="px-2 py-2 break-words">
                      {line.description}
                      {line.vatExempt ? <span className="text-ink-soft"> (פטור ממע״מ)</span> : null}
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums">{quantityText(line.quantity)}</td>
                    <td className="px-2 py-2 text-end tabular-nums">{formatMoney(line.unitPriceAgorot)}</td>
                    <td className="px-2 py-2 text-end tabular-nums">{line.discountAgorot > 0 ? formatMoney(line.discountAgorot) : ""}</td>
                    <td className="px-2 py-2 text-end tabular-nums">{formatMoney(line.totalAgorot)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <dl className="ms-auto max-w-xs space-y-1 text-sm">
        {doc.netAgorot !== null && doc.vatAgorot !== null ? (
          <>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">לפני מע״מ</dt>
              <dd className="tabular-nums">{formatMoney(doc.netAgorot)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-ink-soft">מע״מ{doc.vatRateBp !== null ? ` (${rateText(doc.vatRateBp)})` : ""}</dt>
              <dd className="tabular-nums">{formatMoney(doc.vatAgorot)}</dd>
            </div>
          </>
        ) : null}
        <div className="flex justify-between gap-4 border-t border-line pt-1 text-md font-semibold">
          <dt>סה״כ</dt>
          <dd className="tabular-nums">{formatMoney(doc.amountAgorot)}</dd>
        </div>
        {owes ? (
          <div className="flex justify-between gap-4 font-medium">
            <dt>יתרה לתשלום</dt>
            <dd className="tabular-nums">{formatMoney(doc.balanceAgorot)}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}

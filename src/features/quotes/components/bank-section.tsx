import { BANK_HEADING, bankRows, type DocumentBank } from "../bank";

/**
 * TAX-02: the business's bank details for a transfer on a customer document (a quote, an order confirmation), as stored
 * on the document when it was sent or numbered. Nothing when there are none or the design hides them.
 */
export function BankSection({ bank, id }: { bank: DocumentBank | null; id: string }) {
  if (!bank) return null;
  return (
    <section aria-labelledby={id} className="space-y-1" data-print-keep="">
      <h2 id={id} className="text-sm font-semibold">
        {BANK_HEADING}
      </h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
        {bankRows(bank).map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-ink-soft">{row.label}</dt>
            <dd>
              {row.number ? (
                <span dir="ltr" className="tabular-nums">
                  {row.value}
                </span>
              ) : (
                <bdi>{row.value}</bdi>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

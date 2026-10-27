import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { BILLING_LABELS } from "@/features/products/schema";
import { vatRateLabel } from "@/features/tax/rates";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";

import type { QuoteDocumentData } from "../design-server";
import type { QuoteLine } from "../queries";
import { BankSection } from "./bank-section";
import { ScheduleSection } from "./schedule-section";
import { noVatText } from "../schema";
import { groupSubtotals, isCounted } from "../totals";

function discountText(line: QuoteLine): string | null {
  if (line.discountBp) return `${formatNumber(line.discountBp / 100)}%`;
  if (line.discountAgorot) return formatMoney(line.discountAgorot);
  return null;
}

function optionalNote(line: QuoteLine): string | null {
  if (!line.isOptional) return null;
  return line.optionalSelected ? "רשות, כלולה בסיכום" : "רשות, לא כלולה בסיכום";
}

/**
 * QUO-05: a quote as its customer sees it, in the business's design: logo, colour, header and footer,
 * the business details (TAX-02) and the customer's billing details (CON-08). Drawn from the stored
 * amounts of the quote, never worked out again here. A table on a wide page and on paper, cards on a
 * phone. The same piece will be the source of the PDF (QUO-06) and of the customer page (QUO-08).
 */
export function QuoteDocument({ data, headingLevel = 1 }: { data: QuoteDocumentData; headingLevel?: 1 | 2 | 3 }) {
  // FXA-09: one main heading per page; a page that has its own main heading shows the quote's title a level lower
  const Title = (["h1", "h2", "h3"] as const)[headingLevel - 1];
  const { design, business, customer, quote, lines } = data;
  const schedule = data.schedule ?? [];
  const sums = groupSubtotals(lines);
  const vatWord = quote.pricesIncludeVat ? 'כולל מע"מ' : 'לפני מע"מ';
  const showVat = quote.noVatReason === null && quote.vatRateBp !== null && quote.vatRateBp > 0;
  const optionalOut = lines.some((line) => line.kind === "item" && line.isOptional && !line.optionalSelected);

  return (
    <BrandScope color={data.color}>
      <article aria-label={`הצעת מחיר: ${quote.title}`} className="space-y-6 rounded-lg border border-line bg-surface p-4 text-ink sm:p-8 print:border-0 print:p-0">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b-2 border-accent pb-4">
          <div className="min-w-0 space-y-1">
            {data.logoUrl ? <OrgLogo url={data.logoUrl} alt={design.showBusinessDetails ? "" : business.name} className="mb-2 h-14 max-w-48" /> : null}
            {design.showBusinessDetails ? (
              <div className="space-y-0.5 text-sm">
                <p className="text-base font-semibold">
                  <bdi>{business.name}</bdi>
                </p>
                {business.taxId ? (
                  <p>
                    מספר עוסק או ח.פ.:{" "}
                    <span dir="ltr" className="tabular-nums">
                      {business.taxId}
                    </span>
                  </p>
                ) : null}
                {business.address ? <p>{business.address}</p> : null}
                {business.phone || business.email ? (
                  <p className="flex flex-wrap gap-x-3">
                    {business.phone ? <span dir="ltr">{business.phone}</span> : null}
                    {business.email ? <span dir="ltr">{business.email}</span> : null}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="space-y-1 text-sm sm:text-end">
            <p className="text-lead font-semibold text-accent-strong">הצעת מחיר</p>
            {quote.status === "draft" ? (
              <p>טיוטה, עוד ללא מספר</p>
            ) : quote.numberDisplay ? (
              <p>
                מספר:{" "}
                <bdi dir="ltr" className="font-medium tabular-nums">
                  {quote.numberDisplay}
                </bdi>
              </p>
            ) : null}
            <p>תאריך: {formatDate(quote.quoteDate)}</p>
            {quote.validUntil ? <p>בתוקף עד: {formatDate(quote.validUntil)}</p> : null}
          </div>
        </header>

        {design.headerText ? <p className="text-md whitespace-pre-line">{design.headerText}</p> : null}

        <section aria-label="פרטי ההצעה" className="flex flex-wrap justify-between gap-4">
          <div className="min-w-0 space-y-0.5 text-sm">
            <p className="text-ink-soft">לכבוד</p>
            {customer ? (
              <>
                <p className="text-base font-semibold">
                  <bdi>{customer.name}</bdi>
                </p>
                {customer.attention ? (
                  <p>
                    לידי <bdi>{customer.attention}</bdi>
                  </p>
                ) : null}
                {customer.taxId ? (
                  <p>
                    מספר מזהה:{" "}
                    <span dir="ltr" className="tabular-nums">
                      {customer.taxId}
                    </span>
                  </p>
                ) : null}
                {customer.address ? <p>{customer.address}</p> : null}
                {customer.email ? <p dir="ltr" className="text-start">{customer.email}</p> : null}
              </>
            ) : (
              <p>—</p>
            )}
          </div>
          <Title className="text-lead font-semibold break-words sm:max-w-[60%] sm:text-end">
            <bdi>{quote.title}</bdi>
          </Title>
        </section>

        {lines.length === 0 ? (
          <p className="text-md text-ink-soft">אין שורות בהצעה.</p>
        ) : (
          <>
            {/* a wide page and paper: a table whose header repeats on every printed page */}
            <table className="hidden w-full border-collapse text-sm sm:table">
              <caption className="sr-only">שורות ההצעה, המחירים {vatWord}</caption>
              <thead>
                <tr className="border-b-2 border-line-strong text-start">
                  <th scope="col" className="py-2 text-start font-semibold">
                    תיאור
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-semibold">
                    כמות
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-semibold">
                    מחיר ליחידה
                  </th>
                  <th scope="col" className="px-2 py-2 text-end font-semibold">
                    הנחה
                  </th>
                  <th scope="col" className="py-2 text-end font-semibold">
                    סכום
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) =>
                  line.kind === "group" ? (
                    <tr key={line.id} className="border-b border-line-strong">
                      <th scope="rowgroup" colSpan={4} className="pt-4 pb-1 text-start font-semibold text-accent-strong">
                        <bdi>{line.name}</bdi>
                      </th>
                      <td className="pt-4 pb-1 text-end tabular-nums text-ink-soft">{formatMoney(sums.get(line.id) ?? 0)}</td>
                    </tr>
                  ) : (
                    <tr key={line.id} className="border-b border-line align-top">
                      <td className="py-2">
                        <p className="font-medium">
                          <bdi>{line.name}</bdi>
                        </p>
                        {line.description ? <p className="whitespace-pre-line text-ink-soft">{line.description}</p> : null}
                        {optionalNote(line) || line.billing !== "one_time" ? (
                          <p className="text-ink-soft">{[optionalNote(line), line.billing !== "one_time" ? BILLING_LABELS[line.billing] : null].filter(Boolean).join(", ")}</p>
                        ) : null}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {formatNumber(line.quantity)}
                        {line.unitName ? ` ${line.unitName}` : ""}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">{formatMoney(line.unitPriceAgorot)}</td>
                      <td className="px-2 py-2 text-end tabular-nums">{discountText(line) ?? ""}</td>
                      <td className={`py-2 text-end font-medium tabular-nums ${isCounted(line) ? "" : "text-ink-soft"}`}>{formatMoney(line.totalAgorot)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>

            {/* a phone: one card per line */}
            <ol aria-label="שורות ההצעה" className="space-y-2 sm:hidden">
              {lines.map((line) =>
                line.kind === "group" ? (
                  <li key={line.id} className="flex justify-between gap-2 border-b border-line-strong pt-3 pb-1 font-semibold text-accent-strong">
                    <bdi>{line.name}</bdi>
                    <span className="tabular-nums text-ink-soft">{formatMoney(sums.get(line.id) ?? 0)}</span>
                  </li>
                ) : (
                  <li key={line.id} className="rounded-md border border-line p-3 text-sm">
                    <div className="flex justify-between gap-2">
                      <p className="min-w-0 font-medium break-words">
                        <bdi>{line.name}</bdi>
                      </p>
                      <span className={`shrink-0 font-medium tabular-nums ${isCounted(line) ? "" : "text-ink-soft"}`}>{formatMoney(line.totalAgorot)}</span>
                    </div>
                    {line.description ? <p className="whitespace-pre-line text-ink-soft">{line.description}</p> : null}
                    <p className="text-ink-soft">
                      {formatNumber(line.quantity)}
                      {line.unitName ? ` ${line.unitName}` : ""} × {formatMoney(line.unitPriceAgorot)}
                      {discountText(line) ? `, הנחה ${discountText(line)}` : ""}
                      {optionalNote(line) ? `, ${optionalNote(line)}` : ""}
                      {line.billing !== "one_time" ? `, ${BILLING_LABELS[line.billing]}` : ""}
                    </p>
                  </li>
                ),
              )}
            </ol>
          </>
        )}

        <section aria-label="סיכום" className="flex justify-end" data-print-keep="">
          <dl className="w-full space-y-1 text-md sm:w-80">
            <div className="flex justify-between gap-3">
              <dt>סכום השורות ({vatWord})</dt>
              <dd className="tabular-nums">{formatMoney(quote.subtotalAgorot)}</dd>
            </div>
            {quote.discountTotalAgorot > 0 ? (
              <div className="flex justify-between gap-3">
                <dt>הנחה</dt>
                <dd className="tabular-nums">−{formatMoney(quote.discountTotalAgorot)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt>לפני מע&quot;מ</dt>
              <dd className="tabular-nums">{formatMoney(quote.netTotalAgorot)}</dd>
            </div>
            {showVat ? (
              <div className="flex justify-between gap-3">
                <dt>מע&quot;מ {vatRateLabel(quote.vatRateBp ?? 0)}</dt>
                <dd className="tabular-nums">{formatMoney(quote.vatAgorot)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3 border-t-2 border-accent pt-1 font-semibold">
              <dt>סה&quot;כ לתשלום</dt>
              <dd className="tabular-nums">{formatMoney(quote.totalAgorot)}</dd>
            </div>
            {quote.noVatReason ? <p className="text-sm text-ink-soft">{noVatText(quote.noVatReason, quote.noVatNote)}</p> : null}
            {optionalOut ? <p className="text-sm text-ink-soft">שורות רשות שלא סומנו אינן כלולות בסיכום.</p> : null}
          </dl>
        </section>

        {/* GAP-09: the payment schedule, each step with its share of the total */}
        <ScheduleSection rows={schedule} id="quote-schedule" />

        {/* TAX-02: the bank details stored when the quote was sent, while the design shows them */}
        <BankSection bank={design.showBankDetailsQuote ? quote.bankDetails : null} id="quote-bank" />

        {quote.notes ? (
          <section aria-label="הערות" className="space-y-1" data-print-keep="">
            <h2 className="text-sm font-semibold">הערות</h2>
            <p className="text-sm whitespace-pre-line">{quote.notes}</p>
          </section>
        ) : null}
        {quote.terms ? (
          <section aria-label="תנאים" className="space-y-1">
            <h2 className="text-sm font-semibold">תנאים</h2>
            <p className="text-sm whitespace-pre-line">{quote.terms}</p>
          </section>
        ) : null}

        {design.footerText ? (
          <footer className="border-t border-line pt-3 text-sm whitespace-pre-line text-ink-soft">{design.footerText}</footer>
        ) : null}
      </article>
    </BrandScope>
  );
}

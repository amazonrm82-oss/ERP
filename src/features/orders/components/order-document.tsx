import { BrandScope } from "@/features/branding/components/brand-scope";
import { OrgLogo } from "@/features/branding/components/org-logo";
import { BILLING_LABELS } from "@/features/products/schema";
import { BankSection } from "@/features/quotes/components/bank-section";
import { ScheduleSection } from "@/features/quotes/components/schedule-section";
import { groupSubtotals } from "@/features/quotes/totals";
import { vatRateLabel } from "@/features/tax/rates";
import { formatDate, formatMoney, formatNumber } from "@/lib/format";

import type { OrderDocumentData } from "../document-server";
import type { OrderLine } from "../queries";

// ORD-05 (SPEC-ADDITIONS 6.3): an order is an internal document, never an accounting one, and says so on its face
export const NOT_A_TAX_INVOICE = "אינו חשבונית מס";

function discountText(line: OrderLine): string | null {
  if (line.discountBp) return `${formatNumber(line.discountBp / 100)}%`;
  if (line.discountAgorot) return formatMoney(line.discountAgorot);
  return null;
}

function billingText(line: OrderLine): string | null {
  return line.billing !== "one_time" && line.billing in BILLING_LABELS ? BILLING_LABELS[line.billing as keyof typeof BILLING_LABELS] : null;
}

/**
 * ORD-05 part one: an order confirmation as its customer sees it, in the business's quote design: logo, colour, header
 * and footer, the business details and the customer's billing details, the delivery date and the shipping address.
 * Drawn from the stored amounts of the order. A table on a wide page and on paper, cards on a phone. "אינו חשבונית מס"
 * stands under the title and again by the total.
 */
export function OrderDocument({ data, headingLevel = 1 }: { data: OrderDocumentData; headingLevel?: 1 | 2 | 3 }) {
  const Title = (["h1", "h2", "h3"] as const)[headingLevel - 1];
  const { design, business, customer, order, lines } = data;
  const sums = groupSubtotals(lines.map((line) => ({ ...line, isOptional: false, optionalSelected: false })));
  const vatWord = order.pricesIncludeVat ? 'כולל מע"מ' : 'לפני מע"מ';
  const showVat = order.noVatReason === null && order.vatRateBp !== null && order.vatRateBp > 0;

  return (
    <BrandScope color={data.color}>
      <article aria-label="אישור הזמנה" className="space-y-6 rounded-lg border border-line bg-surface p-4 text-ink sm:p-8 print:border-0 print:p-0">
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
            <Title className="text-lead font-semibold text-accent-strong">אישור הזמנה</Title>
            <p className="font-medium">{NOT_A_TAX_INVOICE}</p>
            {order.numberDisplay ? (
              <p>
                מספר:{" "}
                <bdi dir="ltr" className="font-medium tabular-nums">
                  {order.numberDisplay}
                </bdi>
              </p>
            ) : (
              <p>טיוטה, עוד ללא מספר</p>
            )}
            <p>תאריך: {formatDate(order.orderDate)}</p>
            {order.deliveryDate ? <p>מועד אספקה: {formatDate(order.deliveryDate)}</p> : null}
          </div>
        </header>

        {design.headerText ? <p className="text-md whitespace-pre-line">{design.headerText}</p> : null}

        <section aria-label="פרטי ההזמנה" className="grid gap-4 sm:grid-cols-2">
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
                {customer.email ? (
                  <p dir="ltr" className="text-start">
                    {customer.email}
                  </p>
                ) : null}
              </>
            ) : (
              <p>—</p>
            )}
          </div>
          {order.shippingAddress ? (
            <div className="min-w-0 space-y-0.5 text-sm">
              <p className="text-ink-soft">כתובת משלוח</p>
              <p className="whitespace-pre-line">{order.shippingAddress}</p>
            </div>
          ) : null}
        </section>

        {lines.length === 0 ? (
          <p className="text-md text-ink-soft">אין שורות בהזמנה.</p>
        ) : (
          <>
            <table className="hidden w-full border-collapse text-sm sm:table">
              <caption className="sr-only">שורות ההזמנה, המחירים {vatWord}</caption>
              <thead>
                <tr className="border-b-2 border-line-strong">
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
                        {billingText(line) ? <p className="text-ink-soft">{billingText(line)}</p> : null}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {formatNumber(line.quantity)}
                        {line.unitName ? ` ${line.unitName}` : ""}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">{formatMoney(line.unitPriceAgorot)}</td>
                      <td className="px-2 py-2 text-end tabular-nums">{discountText(line) ?? ""}</td>
                      <td className="py-2 text-end font-medium tabular-nums">{formatMoney(line.totalAgorot)}</td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>

            <ol aria-label="שורות ההזמנה" className="space-y-2 sm:hidden">
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
                      <span className="shrink-0 font-medium tabular-nums">{formatMoney(line.totalAgorot)}</span>
                    </div>
                    {line.description ? <p className="whitespace-pre-line text-ink-soft">{line.description}</p> : null}
                    <p className="text-ink-soft">
                      {formatNumber(line.quantity)}
                      {line.unitName ? ` ${line.unitName}` : ""} × {formatMoney(line.unitPriceAgorot)}
                      {discountText(line) ? `, הנחה ${discountText(line)}` : ""}
                      {billingText(line) ? `, ${billingText(line)}` : ""}
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
              <dd className="tabular-nums">{formatMoney(order.subtotalAgorot)}</dd>
            </div>
            {order.discountTotalAgorot > 0 ? (
              <div className="flex justify-between gap-3">
                <dt>הנחה</dt>
                <dd className="tabular-nums">−{formatMoney(order.discountTotalAgorot)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3">
              <dt>לפני מע&quot;מ</dt>
              <dd className="tabular-nums">{formatMoney(order.netTotalAgorot)}</dd>
            </div>
            {showVat ? (
              <div className="flex justify-between gap-3">
                <dt>מע&quot;מ {vatRateLabel(order.vatRateBp ?? 0)}</dt>
                <dd className="tabular-nums">{formatMoney(order.vatAgorot)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3 border-t-2 border-accent pt-1 font-semibold">
              <dt>סה&quot;כ</dt>
              <dd className="tabular-nums">{formatMoney(order.totalAgorot)}</dd>
            </div>
            <p className="text-sm text-ink-soft">מסמך זה {NOT_A_TAX_INVOICE}.</p>
          </dl>
        </section>

        {/* ORD-04: the payment schedule, each step with its share of the total */}
        <ScheduleSection rows={data.schedule} id="order-schedule" />

        {/* TAX-02: the bank details stored when the order got its number, while the design shows them */}
        <BankSection bank={design.showBankDetails ? data.order.bankDetails : null} id="order-bank" />

        {order.notes ? (
          <section aria-label="הערות" className="space-y-1" data-print-keep="">
            <h2 className="text-sm font-semibold">הערות</h2>
            <p className="text-sm whitespace-pre-line">{order.notes}</p>
          </section>
        ) : null}

        {design.footerText ? <footer className="border-t border-line pt-3 text-sm whitespace-pre-line text-ink-soft">{design.footerText}</footer> : null}
      </article>
    </BrandScope>
  );
}

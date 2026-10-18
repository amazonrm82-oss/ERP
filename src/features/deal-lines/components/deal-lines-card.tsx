"use client";

import { useState, useTransition } from "react";

import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";
import { ReorderButtons } from "@/components/ui/reorder-buttons";
import { linesValueNote, monthlyRecurringAgorot } from "@/features/deals/recurring";
import { LineCost } from "@/features/product-costs/components/line-cost";
import { linesProfit, marginText } from "@/features/product-costs/margin";
import { documentVatRateBp } from "@/features/tax/calc";
import { documentVatError, vatRateLabel, type DocumentVat } from "@/features/tax/rates";
import { formatMoney, formatNumber } from "@/lib/format";
import { paths } from "@/lib/paths";

import { deleteDealLineAction, moveDealLineAction } from "../actions";
import { dealLinesNet, dealLinesTotals } from "../pricing";
import type { DealLine } from "../queries";
import { lineBillingText, MAKE_RECURRING_LABEL, makeRecurringOffer } from "../recurring";
import { DEAL_LINES_MAX, priceSourceText } from "../schema";
import { DealLineForm } from "./deal-line-form";

/** What the prices on this deal depend on (readDealPricing), as the page passes it. */
export type LinesPricing = {
  day: string;
  includesVat: boolean;
  rateBp: number;
  vat: DocumentVat;
  list: { id: string; name: string; isActive: boolean; validFrom: string | null; validTo: string | null } | null;
};

type Props = {
  orgId: string;
  dealId: string;
  lines: DealLine[];
  pricing: LinesPricing;
  canEdit: boolean;
  features: { products: boolean; discounts: boolean };
  canCreateProducts: boolean;
  // DLI-03: what the deal value follows (deals.amount_auto, amount_source, recurring_amount_auto)
  // DLI-04: the deal's recurring amount as shown (null = one-time or empty)
  dealValue: { kind: string | null; auto: boolean; source: string | null; recurringAuto: boolean; recurringAgorot: number | null };
  // PRD-06: per line id, the cost per unit kept on the line (null = none) and its product's cost in the catalog today
  // (null = none), for those who see costs; null for anyone else
  costs: Record<string, { cost: number | null; catalog: number | null }> | null;
  // a hint only (the database decides): the deal is open and the user may edit it and its line costs
  canEditCosts: boolean;
};

function discountText(line: DealLine): string | null {
  if (line.discountBp) return `הנחה ${formatNumber(line.discountBp / 100)}%`;
  if (line.discountAgorot) return `הנחה ${formatMoney(line.discountAgorot)}`;
  return null;
}

/**
 * DLI-01: the "מוצרים" section of a deal: its lines in order, each with quantity, unit price,
 * discount and amount, and the totals with VAT under them by the one totals rule (TAX-05). DLI-03: the
 * deal's value follows their sum before VAT unless a person typed it; the card says which.
 */
export function DealLinesCard({ orgId, dealId, lines, pricing, canEdit, features, canCreateProducts, dealValue, costs, canEditCosts }: Props) {
  const [editing, setEditing] = useState<DealLine | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const close = () => setEditing(null);

  const rateBp = documentVatRateBp(pricing.vat);
  const result = dealLinesTotals(
    lines.map((line) => ({
      quantity: line.quantity,
      unitPriceAgorot: line.unitPriceAgorot,
      discountBp: line.discountBp,
      discountAgorot: line.discountAgorot,
      vatExempt: line.vatExempt,
    })),
    rateBp,
    pricing.includesVat,
  );
  const totals = result.ok ? result.totals : null;
  const vatMissing = documentVatError(pricing.vat);
  // DLI-04: the monthly recurring revenue the lines make (a recurring amount that follows them)
  const monthly = dealValue.recurringAuto ? monthlyRecurringAgorot(dealValue.kind, dealValue.recurringAgorot) : null;
  // DLI-04: a one-time deal with a recurring line: the offer to make it recurring (never done by itself)
  const recurringOffer = makeRecurringOffer(
    dealValue.kind,
    lines.map((line) => line.billing),
  );

  function move(line: DealLine, direction: -1 | 1) {
    setError(null);
    startTransition(async () => {
      const outcome = await moveDealLineAction(orgId, dealId, line.id, direction === -1 ? "up" : "down");
      if (!outcome.ok) setError(outcome.message);
    });
  }

  const full = lines.length >= DEAL_LINES_MAX;
  // PRD-06: the gross profit of the lines whose product has a cost (before VAT), for those who see costs
  const profit =
    costs === null
      ? null
      : linesProfit(
          lines.map((line) => ({
            unitCostAgorot: costs[line.id]?.cost ?? null,
            quantity: line.quantity,
            netAgorot: dealLinesNet(
              [{ quantity: line.quantity, unitPriceAgorot: line.unitPriceAgorot, discountBp: line.discountBp, discountAgorot: line.discountAgorot, vatExempt: line.vatExempt }],
              pricing.rateBp,
              pricing.includesVat,
            ),
          })),
        );

  return (
    <Card aria-labelledby="deal-lines-title">
      <CardHeader
        id="deal-lines-title"
        title="מוצרים"
        action={
          canEdit && !full ? (
            <Button variant="secondary" size="sm" className="print:hidden" onClick={() => setEditing("new")}>
              <PlusIcon className="size-4" />
              הוספת שורה
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-4">
        <FormError message={error} />
        {lines.length === 0 ? (
          <p className="text-md text-ink-soft">
            {canEdit ? "עוד אין מוצרים בעסקה. מוסיפים מוצר מהקטלוג או שורה חופשית." : "עוד אין מוצרים בעסקה."}
          </p>
        ) : (
          <ol aria-label="שורות המוצרים" className="divide-y divide-line">
            {lines.map((line, index) => {
              const discount = discountText(line);
              return (
                <li key={line.id} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">
                      <bdi>{line.description}</bdi>
                    </p>
                    <p className="text-sm text-ink-soft">
                      <span dir="ltr" className="tabular-nums">
                        {formatNumber(line.quantity)}
                      </span>
                      {" × "}
                      <span className="tabular-nums">{formatMoney(line.unitPriceAgorot)}</span>
                      {discount ? `, ${discount}` : ""}
                      {line.vatExempt && pricing.vat.kind !== "none" ? ', פטור ממע"מ' : ""}
                      {lineBillingText(line.billing)}
                    </p>
                    {line.productId ? <p className="text-sm text-ink-soft">{priceSourceText(line.source, line.priceListName)}</p> : null}
                    {costs ? (
                      <LineCost
                        orgId={orgId}
                        dealId={dealId}
                        lineId={line.id}
                        cost={costs[line.id]?.cost ?? null}
                        catalog={line.productId ? (costs[line.id]?.catalog ?? null) : null}
                        canEdit={canEditCosts}
                      />
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span className="me-1 font-semibold tabular-nums">{formatMoney(line.totalAgorot)}</span>
                    {canEdit ? (
                      <span className="flex items-center print:hidden">
                        <ReorderButtons name={line.description} first={index === 0} last={index === lines.length - 1} disabled={pending} onMove={(d) => move(line, d)} />
                        <Button variant="ghost" size="sm" onClick={() => setEditing(line)} aria-label={`עריכה: ${line.description}`}>
                          עריכה
                        </Button>
                        <ConfirmButton
                          title={`למחוק את השורה "${line.description}"?`}
                          description="המוצר עצמו נשאר בקטלוג."
                          confirmLabel="מחיקה"
                          action={() => deleteDealLineAction(orgId, dealId, line.id)}
                        >
                          מחיקה
                        </ConfirmButton>
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        {lines.length > 0 && totals ? (
          <dl className="space-y-1 border-t border-line pt-3 text-md">
            {pricing.vat.kind === "rate" ? (
              <>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">לפני מע&quot;מ</dt>
                  <dd className="tabular-nums">{formatMoney(totals.netTotalAgorot)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-soft">מע&quot;מ {vatRateLabel(pricing.vat.rateBp)}</dt>
                  <dd className="tabular-nums">{formatMoney(totals.vatAgorot)}</dd>
                </div>
                <div className="flex justify-between gap-3 font-semibold">
                  <dt>סה&quot;כ כולל מע&quot;מ</dt>
                  <dd className="tabular-nums">{formatMoney(totals.totalAgorot)}</dd>
                </div>
              </>
            ) : pricing.vat.kind === "none" ? (
              <div className="flex justify-between gap-3 font-semibold">
                <dt>סה&quot;כ</dt>
                <dd className="tabular-nums">{formatMoney(totals.totalAgorot)}</dd>
              </div>
            ) : (
              <div className="flex justify-between gap-3 font-semibold">
                <dt>{pricing.includesVat ? 'סה"כ השורות (כולל מע"מ)' : 'סה"כ השורות (לפני מע"מ)'}</dt>
                <dd className="tabular-nums">{formatMoney(totals.subtotalAgorot)}</dd>
              </div>
            )}
          </dl>
        ) : null}
        {profit ? (
          <div className="space-y-1 rounded-md border border-line px-3 py-2.5 text-md print:hidden">
            <p className="flex justify-between gap-3">
              <span className="text-ink-soft">עלות המוצרים</span>
              <span className="tabular-nums">{formatMoney(profit.costAgorot)}</span>
            </p>
            <p className="flex justify-between gap-3 font-semibold">
              <span>רווח גולמי (לפני מע&quot;מ)</span>
              <span className={profit.profitAgorot < 0 ? "tabular-nums text-danger" : "tabular-nums"}>
                {formatMoney(profit.profitAgorot)}
                {profit.marginBp !== null ? ` (${marginText(profit.marginBp)})` : ""}
              </span>
            </p>
            {profit.uncosted > 0 ? (
              <p className="text-sm text-ink-soft">
                {profit.uncosted === 1 ? "שורה אחת בלי עלות לא נכללה בחישוב." : `${profit.uncosted} שורות בלי עלות לא נכללו בחישוב.`}
              </p>
            ) : null}
            <p className="text-sm text-ink-soft">לפי העלות שנשמרה בכל שורה. רק מי שמורשה לראות עלות רואה את החלק הזה.</p>
          </div>
        ) : null}
        {lines.length > 0 && monthly !== null && monthly > 0 ? (
          <p className="flex justify-between gap-3 text-md">
            <span className="text-ink-soft">הכנסה חודשית חוזרת (לפני מע&quot;מ)</span>
            <span className="font-semibold tabular-nums">{formatMoney(monthly)}</span>
          </p>
        ) : null}
        {lines.length > 0 && recurringOffer ? (
          <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
            <p className="min-w-0 flex-1">{recurringOffer}</p>
            {canEdit ? (
              <ButtonLink href={`${paths.deal(orgId, dealId)}?edit=billing_kind`} variant="secondary" size="sm" className="print:hidden">
                {MAKE_RECURRING_LABEL}
              </ButtonLink>
            ) : null}
          </div>
        ) : null}
        {lines.length > 0 && vatMissing ? <p className="text-sm text-ink-soft">{vatMissing}</p> : null}
        {lines.length > 0 ? (
          <p className="text-sm text-ink-soft">
            {pricing.includesVat ? 'המחירים בשורות כוללים מע"מ.' : 'המחירים בשורות לפני מע"מ.'} {linesValueNote(dealValue)}
          </p>
        ) : null}
        {canEdit && full ? <p className="text-sm text-ink-soft">{`בעסקה יש ${DEAL_LINES_MAX} שורות, המספר המרבי.`}</p> : null}
      </CardBody>

      {canEdit ? (
        <Dialog
          open={editing !== null}
          onClose={close}
          title={editing === "new" ? "שורת מוצר חדשה" : "עריכת שורה"}
          description={pricing.list && editing === "new" ? `מחירון הלקוח: ${pricing.list.name}` : undefined}
          variant="sheet"
        >
          {editing !== null ? (
            <DealLineForm
              key={editing === "new" ? "new" : editing.id}
              orgId={orgId}
              dealId={dealId}
              pricing={pricing}
              line={editing === "new" ? null : editing}
              features={features}
              canCreateProducts={canCreateProducts}
              dealKind={dealValue.kind}
              onDone={close}
              onCancel={close}
            />
          ) : null}
        </Dialog>
      ) : null}
    </Card>
  );
}

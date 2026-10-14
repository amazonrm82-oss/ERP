"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";
import { ReorderButtons } from "@/components/ui/reorder-buttons";
import { documentVatRateBp } from "@/features/tax/calc";
import { documentVatError, vatRateLabel, type DocumentVat } from "@/features/tax/rates";
import { formatMoney, formatNumber } from "@/lib/format";

import { deleteDealLineAction, moveDealLineAction } from "../actions";
import { dealLinesTotals } from "../pricing";
import type { DealLine } from "../queries";
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
};

function discountText(line: DealLine): string | null {
  if (line.discountBp) return `הנחה ${formatNumber(line.discountBp / 100)}%`;
  if (line.discountAgorot) return `הנחה ${formatMoney(line.discountAgorot)}`;
  return null;
}

/**
 * DLI-01: the "מוצרים" section of a deal: its lines in order, each with quantity, unit price,
 * discount and amount, and the totals with VAT under them by the one totals rule (TAX-05). The deal's
 * value is not computed from them (DLI-03 is a later requirement).
 */
export function DealLinesCard({ orgId, dealId, lines, pricing, canEdit, features, canCreateProducts }: Props) {
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

  function move(line: DealLine, direction: -1 | 1) {
    setError(null);
    startTransition(async () => {
      const outcome = await moveDealLineAction(orgId, dealId, line.id, direction === -1 ? "up" : "down");
      if (!outcome.ok) setError(outcome.message);
    });
  }

  const full = lines.length >= DEAL_LINES_MAX;

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
                    </p>
                    {line.productId ? <p className="text-sm text-ink-soft">{priceSourceText(line.source, line.priceListName)}</p> : null}
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
        {lines.length > 0 && vatMissing ? <p className="text-sm text-ink-soft">{vatMissing}</p> : null}
        {lines.length > 0 ? (
          <p className="text-sm text-ink-soft">
            {pricing.includesVat ? 'המחירים בשורות כוללים מע"מ.' : 'המחירים בשורות לפני מע"מ.'} סכום העסקה לא משתנה לפי השורות.
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
              onDone={close}
              onCancel={close}
            />
          ) : null}
        </Dialog>
      ) : null}
    </Card>
  );
}

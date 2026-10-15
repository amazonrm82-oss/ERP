"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { setProductCostAction } from "../actions";
import { costMeaning, marginText, profitOf } from "../margin";

type Props = {
  orgId: string;
  productId: string;
  // the cost per unit (null = none saved)
  costAgorot: number | null;
  // the product's sale price before VAT, today
  netPriceAgorot: number;
  chargesVat: boolean | null;
  canEdit: boolean;
};

/** "12.5" from agorot, for the cost input. */
function costInput(agorot: number): string {
  return agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2);
}

/**
 * PRD-06: the cost of a product and the gross profit on it. The page shows it only to those who
 * see costs (owners, admins, managers and the view_costs grant); the cost itself comes from a table
 * the database closes to everyone else.
 */
export function ProductCostCard({ orgId, productId, costAgorot, netPriceAgorot, chargesVat, canEdit }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(setProductCostAction.bind(null, orgId, productId), null);
  const failure = state && !state.ok ? state : null;
  const profit = costAgorot === null ? null : profitOf(netPriceAgorot, costAgorot);

  return (
    <Card aria-labelledby="product-cost-title">
      <CardHeader id="product-cost-title" title="עלות ורווח" />
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-soft">רק בעלים, מנהלי מערכת, מנהלי צוות ומי שקיבל הרשאה רואים את החלק הזה.</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-ink-soft">עלות ליחידה</dt>
            <dd className="font-medium">{costAgorot === null ? "לא הוזנה" : formatMoney(costAgorot)}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-soft">{chargesVat === false ? "מחיר מכירה" : 'מחיר מכירה לפני מע"מ'}</dt>
            <dd className="font-medium">{formatMoney(netPriceAgorot)}</dd>
          </div>
          {profit ? (
            <div>
              <dt className="text-sm text-ink-soft">רווח גולמי ליחידה</dt>
              <dd className={profit.profitAgorot < 0 ? "font-medium text-danger" : "font-medium"}>
                {formatMoney(profit.profitAgorot)}
                {profit.marginBp !== null ? <span className="text-ink-soft"> ({marginText(profit.marginBp)})</span> : null}
              </dd>
            </div>
          ) : null}
        </dl>
        {canEdit ? (
          <form action={formAction} className="space-y-3" noValidate>
            <FormGuard state={state} />
            <FormError message={failure?.message} />
            {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
            <TextField
              label="עלות ליחידה (₪)"
              name="cost"
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              hint={`${costMeaning(chargesVat)} ריק = בלי עלות.`}
              defaultValue={failure?.values?.cost ?? (costAgorot === null ? "" : costInput(costAgorot))}
              error={failure?.fieldErrors?.cost}
              className="sm:max-w-xs"
            />
            <SubmitButton pendingText="שומרים…">שמירת העלות</SubmitButton>
          </form>
        ) : (
          <p className="text-sm text-ink-soft">{costMeaning(chargesVat)}</p>
        )}
      </CardBody>
    </Card>
  );
}

"use client";

import { useActionState, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { Input, TextField } from "@/components/ui/field";
import { SearchPicker } from "@/components/ui/search-picker";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { formatMoney, formatNumber } from "@/lib/format";

import { BUNDLE_PARTS_MAX } from "../bundle";
import { addBundlePartAction, removeBundlePartAction, searchBundlePartsAction, setBundlePartQuantityAction } from "../bundle-actions";

export type BundlePartView = { id: string; name: string; sku: string | null; quantity: number; unitName: string | null; offerable: boolean };

type Props = {
  orgId: string;
  bundleId: string;
  parts: BundlePartView[];
  // the parts' sum in the bundle's own VAT mode, for reference (null = no parts)
  referenceAgorot: number | null;
  priceMode: string;
  canEdit: boolean;
};

/**
 * PRD-09: what a bundle is made of. Everyone reads it; catalog editors add a part (an active product that is not a
 * bundle), change its quantity per bundle, or remove it. The bundle keeps its own price; the parts' sum is shown only for
 * reference.
 */
export function BundlePartsCard({ orgId, bundleId, parts, referenceAgorot, priceMode, canEdit }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(addBundlePartAction.bind(null, orgId, bundleId), null);
  const [error, setError] = useState<string | null>(null);
  const failure = state && !state.ok ? state : null;
  const full = parts.length >= BUNDLE_PARTS_MAX;

  return (
    <Card aria-labelledby="bundle-parts-title">
      <CardHeader id="bundle-parts-title" title="רכיבי החבילה" />
      <CardBody className="space-y-4">
        <p className="text-sm text-ink-soft">
          במסמך אפשר להציג את החבילה כשורה אחת או מפורטת, עם הרכיבים והכמויות שלהם. המחיר הוא המחיר של החבילה עצמה.
        </p>
        <FormError message={error} />
        {parts.length === 0 ? (
          <p className="text-md text-ink-soft">{canEdit ? "עוד אין רכיבים בחבילה. מוסיפים מוצר מהקטלוג וכמות." : "עוד אין רכיבים בחבילה."}</p>
        ) : (
          <ul aria-label="הרכיבים" className="divide-y divide-line">
            {parts.map((part) => (
              <PartRow key={part.id} orgId={orgId} bundleId={bundleId} part={part} canEdit={canEdit} onError={setError} />
            ))}
          </ul>
        )}
        {referenceAgorot !== null ? (
          <p className="flex flex-wrap justify-between gap-x-3 border-t border-line pt-3 text-md">
            <span className="text-ink-soft">סכום הרכיבים לפי המחירים בקטלוג ({priceMode}), לעיון בלבד</span>
            <span className="font-semibold tabular-nums">{formatMoney(referenceAgorot)}</span>
          </p>
        ) : null}
        {canEdit && !full ? (
          <form key={state?.ok ? parts.length : "form"} action={formAction} className="space-y-3 border-t border-line pt-3" noValidate>
            <FormError message={failure?.message} />
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
              <SearchPicker
                label="מוצר להוספה"
                name="component_id"
                initial={null}
                search={(query) => searchBundlePartsAction(orgId, bundleId, query)}
                placeholder='הקלידו שם, מק"ט או ברקוד'
                error={failure?.fieldErrors?.component_id}
                required
              />
              <TextField
                label="כמות"
                name="quantity"
                dir="ltr"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={failure?.values?.quantity ?? "1"}
                error={failure?.fieldErrors?.quantity}
              />
            </div>
            <SubmitButton size="sm" pendingText="מוסיפים…">
              הוספת רכיב
            </SubmitButton>
          </form>
        ) : null}
        {canEdit && full ? <p className="text-sm text-ink-soft">{`בחבילה יש ${BUNDLE_PARTS_MAX} רכיבים, המספר המרבי.`}</p> : null}
      </CardBody>
    </Card>
  );
}

function PartRow({
  orgId,
  bundleId,
  part,
  canEdit,
  onError,
}: {
  orgId: string;
  bundleId: string;
  part: BundlePartView;
  canEdit: boolean;
  onError: (message: string | null) => void;
}) {
  const [quantity, setQuantity] = useState(String(part.quantity));
  const [pending, startTransition] = useTransition();
  const changed = quantity.trim() !== String(part.quantity);

  function save() {
    onError(null);
    startTransition(async () => {
      const outcome = await setBundlePartQuantityAction(orgId, bundleId, part.id, quantity);
      if (!outcome.ok) onError(outcome.message);
    });
  }

  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="break-words font-medium">
          <bdi>{part.name}</bdi>
          {part.offerable ? null : (
            <Badge className="ms-2" tone="warning">
              לא פעיל
            </Badge>
          )}
        </p>
        {canEdit ? null : (
          <p className="text-sm text-ink-soft">
            כמות בחבילה:{" "}
            <span dir="ltr" className="tabular-nums">
              {formatNumber(part.quantity)}
            </span>
            {part.unitName ? ` ${part.unitName}` : ""}
          </p>
        )}
        {part.sku ? (
          <p dir="ltr" className="text-start text-sm text-ink-soft">
            {part.sku}
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <div className="flex shrink-0 items-center gap-1">
          <Input
            aria-label={`כמות של ${part.name} בחבילה`}
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            controlSize="sm"
            className="w-20"
          />
          {part.unitName ? <span className="text-sm text-ink-soft">{part.unitName}</span> : null}
          {changed ? (
            <Button variant="secondary" size="sm" onClick={save} loading={pending}>
              שמירה
            </Button>
          ) : null}
          <ConfirmButton
            title={`להסיר את "${part.name}" מהחבילה?`}
            description="המוצר עצמו נשאר בקטלוג. מסמכים שכבר נשלחו לא משתנים."
            confirmLabel="הסרה"
            action={() => removeBundlePartAction(orgId, bundleId, part.id)}
          >
            הסרה
          </ConfirmButton>
        </div>
      ) : null}
    </li>
  );
}

"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { ProductHit } from "@/features/deal-lines/actions";
import { DealProductPicker } from "@/features/deal-lines/components/deal-product-picker";
import { lineTotal, pulledPrice } from "@/features/deal-lines/pricing";
import { DISCOUNT_KIND_LABELS, DISCOUNT_KINDS, LINE_BILLING_LABEL, priceSourceText, VAT_EXEMPT_LABEL, type DiscountKind } from "@/features/deal-lines/schema";
import { agorotInput } from "@/features/deals/recurring";
import { BILLING_LABELS, BILLINGS } from "@/features/products/schema";
import type { FormState } from "@/lib/action-result";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

import { addQuoteLineAction, updateQuoteLineAction } from "../actions";
import type { QuoteLine } from "../queries";
import { QUOTE_LINE_DESCRIPTION_MAX, QUOTE_LINE_NAME_MAX } from "../schema";
import type { EditorPricing } from "./quote-editor";

type Props = {
  orgId: string;
  quoteId: string;
  pricing: EditorPricing;
  // null = a new line
  line: QuoteLine | null;
  features: { products: boolean; discounts: boolean };
  onDone: () => void;
  onCancel: () => void;
};

function percentInput(bp: number | null): string {
  if (bp === null) return "";
  return bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, "");
}

function quantityOf(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  if (cleaned === "") return 1;
  return /^\d{1,7}(\.\d{1,3})?$/.test(cleaned) && Number(cleaned) > 0 ? Number(cleaned) : null;
}

/**
 * QUO-02: add or change an item line. A product line copies the product's name and description (PRD-03;
 * both stay editable) and, with an empty price, takes the automatic price: the customer's price list with
 * its tiers, else the product's own price (PL-03). The line's amount is worked out while typing.
 */
export function QuoteLineForm({ orgId, quoteId, pricing, line, features, onDone, onCancel }: Props) {
  const action = line ? updateQuoteLineAction.bind(null, orgId, quoteId, line.id) : addQuoteLineAction.bind(null, orgId, quoteId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  const startKind: DiscountKind | "" = line?.discountBp ? "percent" : line?.discountAgorot ? "amount" : "";
  const [product, setProduct] = useState<ProductHit | null>(null);
  const [name, setName] = useState(line?.name ?? "");
  const [description, setDescription] = useState(line?.description ?? "");
  const [quantity, setQuantity] = useState(line ? String(line.quantity) : "1");
  const [price, setPrice] = useState(line ? agorotInput(line.unitPriceAgorot) : "");
  const [discountKind, setDiscountKind] = useState<DiscountKind | "">(startKind);
  const [discount, setDiscount] = useState(line?.discountBp ? percentInput(line.discountBp) : line?.discountAgorot ? agorotInput(line.discountAgorot) : "");
  const [optional, setOptional] = useState(line?.isOptional ?? false);

  const qty = quantityOf(quantity);
  const list = pricing.list && product ? { ...pricing.list, lines: product.tiers } : null;
  const automatic = product && qty !== null ? pulledPrice(product, list, qty, pricing.day, pricing.includesVat, pricing.rateBp) : null;
  const typedPrice = price.trim() === "" ? null : parseMoneyToAgorot(price);
  const unit = typedPrice ?? automatic?.priceAgorot ?? null;
  const discountBp = discountKind === "percent" ? Math.round(Number(discount.replace(/%/g, "")) * 100) : null;
  const discountAgorot = discountKind === "amount" ? parseMoneyToAgorot(discount) : null;
  const preview =
    qty !== null && unit !== null
      ? lineTotal(
          {
            quantity: qty,
            unitPriceAgorot: unit,
            discountBp: discountBp !== null && Number.isFinite(discountBp) && discountBp > 0 ? discountBp : null,
            discountAgorot: discountAgorot !== null && discountAgorot > 0 ? discountAgorot : null,
          },
          pricing.includesVat,
        )
      : null;

  const isProductLine = line ? line.productId !== null : product !== null;
  const priceHint = line
    ? isProductLine
      ? `${priceSourceText(line.source, line.priceListName)}. ריק: המחיר האוטומטי.`
      : undefined
    : automatic
      ? `ריק: ${formatMoney(automatic.priceAgorot)}, ${priceSourceText(automatic.source, automatic.priceListName)}.`
      : undefined;
  const showDiscount = features.discounts || startKind !== "";
  const showVatExempt = !isProductLine && pricing.vat.kind !== "none";
  const vatWord = pricing.includesVat ? 'כולל מע"מ' : 'לפני מע"מ';

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      {line ? null : features.products ? (
        <DealProductPicker
          orgId={orgId}
          dealId={quoteId}
          listId={pricing.list?.id ?? null}
          picked={product}
          canCreate={false}
          includesVat={pricing.includesVat}
          onPick={(picked) => {
            setProduct(picked);
            if (picked && name.trim() === "") setName(picked.name);
            // PRD-03: the product's description too, when the line has none yet (a quote line holds up to 2,000)
            if (picked?.description && description.trim() === "") setDescription(picked.description.slice(0, QUOTE_LINE_DESCRIPTION_MAX));
          }}
        />
      ) : (
        <input type="hidden" name="product_id" value="" />
      )}
      {errors.product_id ? <p className="text-sm text-danger">{errors.product_id}</p> : null}
      <TextField label="שם" name="name" required maxLength={QUOTE_LINE_NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} error={errors.name} />
      <TextareaField
        label="תיאור"
        name="description"
        rows={2}
        maxLength={QUOTE_LINE_DESCRIPTION_MAX}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        hint="מופיע מתחת לשם בהצעה. רשות."
        error={errors.description}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={line?.unitName ? `כמות (${line.unitName})` : "כמות"}
          name="quantity"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          error={errors.quantity}
        />
        <TextField
          label={`מחיר ליחידה (₪, ${vatWord})`}
          name="unit_price"
          required={!isProductLine}
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          placeholder={automatic ? agorotInput(automatic.priceAgorot) : "0"}
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          hint={priceHint}
          error={errors.unit_price}
        />
      </div>
      {showDiscount ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="הנחה בשורה" name="discount_kind" value={discountKind} onChange={(event) => setDiscountKind(event.target.value as DiscountKind | "")}>
            <option value="">{DISCOUNT_KIND_LABELS[""]}</option>
            {DISCOUNT_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {DISCOUNT_KIND_LABELS[kind]}
              </option>
            ))}
          </SelectField>
          {discountKind !== "" ? (
            <TextField
              label={discountKind === "percent" ? "אחוז הנחה" : `סכום הנחה (₪, ${vatWord})`}
              name="discount"
              required
              dir="ltr"
              inputMode="decimal"
              autoComplete="off"
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
              error={errors.discount}
            />
          ) : null}
        </div>
      ) : (
        <input type="hidden" name="discount_kind" value="" />
      )}
      {isProductLine ? null : (
        <SelectField label={LINE_BILLING_LABEL} name="billing" defaultValue={line?.billing ?? "one_time"} error={errors.billing}>
          {BILLINGS.map((billing) => (
            <option key={billing} value={billing}>
              {BILLING_LABELS[billing]}
            </option>
          ))}
        </SelectField>
      )}
      {showVatExempt ? (
        <>
          <input type="hidden" name="vat_exempt_shown" value="1" />
          <Checkbox name="vat_exempt" label={VAT_EXEMPT_LABEL} defaultChecked={line?.vatExempt ?? false} />
        </>
      ) : null}
      <Checkbox
        name="is_optional"
        label="שורת רשות"
        hint="הלקוח יבחר אם לכלול אותה. היא לא נספרת בסיכום עד שנבחרת."
        checked={optional}
        onChange={(event) => setOptional(event.target.checked)}
      />
      {optional ? <Checkbox name="optional_selected" label="מסומנת מראש" hint="נספרת בסיכום עד שהלקוח יסיר אותה." defaultChecked={line?.optionalSelected ?? false} /> : null}
      <p aria-live="polite" className="text-md">
        <span className="text-ink-soft">סכום השורה: </span>
        <span className="font-semibold">{preview && preview.ok ? formatMoney(preview.totals.lines[0].totalAgorot) : "—"}</span>
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="שומרים…">{line ? "שמירה" : "הוספת השורה"}</SubmitButton>
        <Button variant="ghost" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

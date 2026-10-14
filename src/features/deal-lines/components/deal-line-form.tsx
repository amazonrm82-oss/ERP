"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { agorotInput } from "@/features/deals/recurring";
import type { FormState } from "@/lib/action-result";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

import { addDealLineAction, updateDealLineAction, type ProductHit } from "../actions";
import { lineTotal, pulledPrice } from "../pricing";
import type { DealLine } from "../queries";
import { DEAL_LINE_DESCRIPTION_MAX, DISCOUNT_KIND_LABELS, DISCOUNT_KINDS, priceSourceText, VAT_EXEMPT_LABEL, type DiscountKind } from "../schema";
import { DealProductPicker } from "./deal-product-picker";
import type { LinesPricing } from "./deal-lines-card";

type Props = {
  orgId: string;
  dealId: string;
  pricing: LinesPricing;
  // null = a new line
  line: DealLine | null;
  features: { products: boolean; discounts: boolean };
  canCreateProducts: boolean;
  onDone: () => void;
  onCancel: () => void;
};

function percentInput(bp: number | null): string {
  if (bp === null) return "";
  return bp % 100 === 0 ? String(bp / 100) : (bp / 100).toFixed(2).replace(/0$/, "");
}

/** "3" or "1.5" -> a number, or null while it is not a quantity yet. */
function quantityOf(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  if (cleaned === "") return 1;
  return /^\d{1,7}(\.\d{1,3})?$/.test(cleaned) && Number(cleaned) > 0 ? Number(cleaned) : null;
}

/**
 * DLI-01: add or change a line. A product line left with an empty price takes the automatic
 * price: the customer's price list with its quantity tiers, else the product's own price (PL-03);
 * the form shows it before saving. A typed price is the person's own and stays as typed.
 */
export function DealLineForm({ orgId, dealId, pricing, line, features, canCreateProducts, onDone, onCancel }: Props) {
  const action = line ? updateDealLineAction.bind(null, orgId, dealId, line.id) : addDealLineAction.bind(null, orgId, dealId);
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await action(prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  const startKind: DiscountKind | "" = line?.discountBp ? "percent" : line?.discountAgorot ? "amount" : "";
  const [product, setProduct] = useState<ProductHit | null>(null);
  const [description, setDescription] = useState(line?.description ?? "");
  const [quantity, setQuantity] = useState(line ? String(line.quantity) : "1");
  const [price, setPrice] = useState(line ? agorotInput(line.unitPriceAgorot) : "");
  const [discountKind, setDiscountKind] = useState<DiscountKind | "">(startKind);
  const [discount, setDiscount] = useState(
    line?.discountBp ? percentInput(line.discountBp) : line?.discountAgorot ? agorotInput(line.discountAgorot) : "",
  );

  const qty = quantityOf(quantity);
  // the automatic price of a picked product, as the server will work it out
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
      ? `${priceSourceText(line.source, line.priceListName)}. ריק: המחיר האוטומטי. שינוי כמות מעדכן את המחיר לפי מדרגות המחירון, כל עוד לא הקלדתם מחיר משלכם.`
      : undefined
    : automatic
      ? `ריק: ${formatMoney(automatic.priceAgorot)}, ${priceSourceText(automatic.source, automatic.priceListName)}.`
      : undefined;
  const showDiscount = features.discounts || startKind !== "";
  // owner, 14 October 2026: a free line may be VAT exempt; a product line takes the product's; a business that
  // charges no VAT does not see the box (every line has no VAT; a stored value is kept)
  const showVatExempt = !isProductLine && pricing.vat.kind !== "none";
  const vatWord = pricing.includesVat ? 'כולל מע"מ' : 'לפני מע"מ';

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      {line ? null : features.products ? (
        <DealProductPicker
          orgId={orgId}
          dealId={dealId}
          listId={pricing.list?.id ?? null}
          picked={product}
          canCreate={canCreateProducts}
          includesVat={pricing.includesVat}
          onPick={(picked) => {
            setProduct(picked);
            if (picked && description.trim() === "") setDescription(picked.name);
          }}
        />
      ) : (
        <input type="hidden" name="product_id" value="" />
      )}
      {errors.product_id ? <p className="text-sm text-danger">{errors.product_id}</p> : null}
      <TextField
        label="תיאור"
        name="description"
        required
        maxLength={DEAL_LINE_DESCRIPTION_MAX}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        error={errors.description}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="כמות"
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
          <SelectField
            label="הנחה בשורה"
            name="discount_kind"
            value={discountKind}
            onChange={(event) => setDiscountKind(event.target.value as DiscountKind | "")}
            error={errors.discount_kind}
          >
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
              placeholder={discountKind === "percent" ? "10" : "50"}
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
              error={errors.discount}
            />
          ) : null}
        </div>
      ) : (
        <input type="hidden" name="discount_kind" value="" />
      )}
      {showVatExempt ? (
        <>
          <input type="hidden" name="vat_exempt_shown" value="1" />
          <Checkbox name="vat_exempt" label={VAT_EXEMPT_LABEL} hint="לשורה בלי מוצר. בשורה עם מוצר זה נקבע לפי המוצר." defaultChecked={line?.vatExempt ?? false} />
        </>
      ) : null}
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

"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ProductHit } from "@/features/deal-lines/actions";
import { DealProductPicker } from "@/features/deal-lines/components/deal-product-picker";
import { lineTotal, pulledPrice } from "@/features/deal-lines/pricing";
import { DISCOUNT_KIND_LABELS, DISCOUNT_KINDS, LINE_BILLING_LABEL, priceSourceText, VAT_EXEMPT_LABEL, type DiscountKind } from "@/features/deal-lines/schema";
import { BILLING_LABELS, BILLINGS } from "@/features/products/schema";
import { agorotInput } from "@/features/deals/recurring";
import type { FormState } from "@/lib/action-result";
import { formatMoney, parseMoneyToAgorot } from "@/lib/format";

import { addOrderLineAction } from "../actions";
import type { OrderPricing } from "../queries";
import { ORDER_LINE_DESCRIPTION_MAX, ORDER_LINE_NAME_MAX } from "../schema";

type Props = {
  orgId: string;
  orderId: string;
  pricing: OrderPricing;
  // the plan holds products: the line may be picked from the catalog
  products: boolean;
  // the plan holds discounts: a line discount may be given
  discounts: boolean;
};

function quantityOf(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  if (cleaned === "") return 1;
  return /^\d{1,7}(\.\d{1,3})?$/.test(cleaned) && Number(cleaned) > 0 ? Number(cleaned) : null;
}

/**
 * ORD-01: a line on a draft order. A product line copies the product's name and description (both stay editable) and,
 * with an empty price, takes the automatic price: the customer's price list with its tiers, else the product's own price
 * (PL-03, as on deal lines and quotes). A free line needs a price. The amount is worked out while typing.
 */
export function OrderLineForm({ orgId, orderId, pricing, products, discounts }: Props) {
  const [product, setProduct] = useState<ProductHit | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [discountKind, setDiscountKind] = useState<DiscountKind | "">("");
  const [discount, setDiscount] = useState("");
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await addOrderLineAction(orgId, orderId, prev, formData);
    // a saved line empties the form for the next one
    if (result?.ok) {
      setProduct(null);
      setName("");
      setDescription("");
      setQuantity("1");
      setPrice("");
      setDiscountKind("");
      setDiscount("");
    }
    return result;
  }, null);
  const failed = state && !state.ok ? state : null;
  const errors = failed?.fieldErrors ?? {};


  const qty = quantityOf(quantity);
  const list = pricing.list && product ? { ...pricing.list, lines: product.tiers } : null;
  const automatic = product && qty !== null ? pulledPrice(product, list, qty, pricing.day, pricing.includesVat, pricing.rateBp) : null;
  const typed = price.trim() === "" ? null : parseMoneyToAgorot(price);
  const unit = typed ?? automatic?.priceAgorot ?? null;
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
  const vatWord = pricing.includesVat ? 'כולל מע"מ' : 'לפני מע"מ';

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failed?.fieldErrors ? undefined : failed?.message} />
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
      {products ? (
        <DealProductPicker
          orgId={orgId}
          dealId={orderId}
          listId={pricing.list?.id ?? null}
          picked={product}
          canCreate={false}
          includesVat={pricing.includesVat}
          onPick={(picked) => {
            setProduct(picked);
            if (picked && name.trim() === "") setName(picked.name);
            if (picked?.description && description.trim() === "") setDescription(picked.description.slice(0, ORDER_LINE_DESCRIPTION_MAX));
          }}
        />
      ) : (
        <input type="hidden" name="product_id" value="" />
      )}
      {errors.product_id ? <p className="text-sm text-danger">{errors.product_id}</p> : null}
      <TextField label="שם" name="name" required maxLength={ORDER_LINE_NAME_MAX} value={name} onChange={(event) => setName(event.target.value)} error={errors.name} />
      <TextareaField
        label="תיאור"
        name="description"
        rows={2}
        maxLength={ORDER_LINE_DESCRIPTION_MAX}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        hint="רשות."
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
          required={product === null}
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          placeholder={automatic ? agorotInput(automatic.priceAgorot) : "0"}
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          hint={automatic ? `ריק: ${formatMoney(automatic.priceAgorot)}, ${priceSourceText(automatic.source, automatic.priceListName)}.` : undefined}
          error={errors.unit_price}
        />
      </div>
      {discounts ? (
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
      {product === null ? (
        // a free line's billing and VAT exemption; a product line takes its product's
        <>
          <SelectField label={LINE_BILLING_LABEL} name="billing" defaultValue="one_time" error={errors.billing}>
            {BILLINGS.map((billing) => (
              <option key={billing} value={billing}>
                {BILLING_LABELS[billing]}
              </option>
            ))}
          </SelectField>
          {pricing.vatCharged ? (
            <>
              <input type="hidden" name="vat_exempt_shown" value="1" />
              <Checkbox name="vat_exempt" label={VAT_EXEMPT_LABEL} />
            </>
          ) : null}
        </>
      ) : null}
      <p aria-live="polite" className="text-md">
        <span className="text-ink-soft">סכום השורה: </span>
        <span className="font-semibold">{preview && preview.ok ? formatMoney(preview.totals.lines[0].totalAgorot) : "—"}</span>
      </p>
      <SubmitButton pendingText="מוסיפים…">הוספת שורה</SubmitButton>
    </form>
  );
}

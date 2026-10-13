"use client";

import { useActionState, useState } from "react";

import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { savePriceListLineAction } from "../actions";
import { unitPriceText } from "../display";
import type { PricingProduct } from "../queries";
import { LINE_RULE_LABELS, LINE_RULES, type LineRule } from "../schema";

type Props = {
  orgId: string;
  listId: string;
  // products that can get a new price (isOfferable), by name
  products: PricingProduct[];
};

/**
 * Adds a price to the list, or replaces the price of the same product from the
 * same quantity (PL-02). A fixed price is typed like a product's price, with
 * its own mode; a discount is a percentage off the product's own price.
 */
export function PriceListLineForm({ orgId, listId, products }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(savePriceListLineAction.bind(null, orgId, listId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const typed = failure?.values;
  const [productId, setProductId] = useState(typed?.product_id ?? "");
  const [rule, setRule] = useState<LineRule>(typed?.rule === "discount" ? "discount" : "price");
  const product = products.find((p) => p.id === productId) ?? null;
  const taxable = product?.vatKind === "taxable";

  if (products.length === 0) {
    return <p className="text-md text-ink-soft">אין מוצרים פעילים בקטלוג. מוסיפים מוצר בעמוד המוצרים, ואז קובעים לו מחיר כאן.</p>;
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
      <SelectField
        label="מוצר"
        name="product_id"
        required
        value={productId}
        onChange={(event) => setProductId(event.target.value)}
        hint={product ? `המחיר במוצר: ${unitPriceText(product, product.vatKind)}` : undefined}
        error={errors.product_id}
      >
        <option value="">בחירת מוצר</option>
        {products.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </SelectField>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="מכמות"
          name="min_quantity"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          placeholder="כל כמות"
          hint="ריק: כל כמות. למשל 10: מחיר אחר מ-10 יחידות."
          defaultValue={typed?.min_quantity ?? ""}
          error={errors.min_quantity}
        />
        <SelectField label="סוג המחיר" name="rule" required value={rule} onChange={(event) => setRule(event.target.value as LineRule)} error={errors.rule}>
          {LINE_RULES.map((value) => (
            <option key={value} value={value}>
              {LINE_RULE_LABELS[value]}
            </option>
          ))}
        </SelectField>
      </div>
      {rule === "price" ? (
        <>
          <TextField
            label="מחיר (₪)"
            name="price_agorot"
            required
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            className="sm:max-w-64"
            defaultValue={typed?.price_agorot ?? ""}
            error={errors.price_agorot}
          />
          {taxable && product ? (
            <Checkbox
              // a new product starts from how its own price is typed
              key={product.id}
              name="price_includes_vat"
              label='המחיר כולל מע"מ'
              hint='בלי סימון, המחיר הוא לפני מע"מ.'
              defaultChecked={typed ? typed.price_includes_vat === "on" : product.priceIncludesVat}
            />
          ) : null}
        </>
      ) : (
        <TextField
          label="אחוז הנחה מהמחיר במוצר"
          name="discount"
          required
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          placeholder="10"
          className="sm:max-w-64"
          hint="למשל 10 או 12.5. המחיר מתעדכן כשהמחיר במוצר משתנה."
          defaultValue={typed?.discount ?? ""}
          error={errors.discount}
        />
      )}
      <p className="text-sm text-ink-soft">כשיש כבר מחיר לאותו מוצר מאותה כמות, הוא יוחלף.</p>
      <SubmitButton pendingText="שומרים…">שמירת המחיר</SubmitButton>
    </form>
  );
}

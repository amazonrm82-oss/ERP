"use client";

import { useActionState, useState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { createProductAction, updateProductAction } from "../actions";
import { productsPath } from "../paths";
import type { Product } from "../queries";
import {
  BILLING_LABELS,
  BILLINGS,
  DURATION_MAX,
  PRODUCT_CODE_MAX,
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_KIND_LABELS,
  PRODUCT_KINDS,
  PRODUCT_NAME_MAX,
  VAT_KIND_LABELS,
  VAT_KINDS,
} from "../schema";

type Option = { id: string; label: string };

type Props = {
  orgId: string;
  // null: a new product
  product: Product | null;
  categories: Option[];
  units: Option[];
  // TAX-04: how the business types prices; a new product starts from it
  orgPricesIncludeVat: boolean;
};

/** "1250.5" from agorot, for the price input. */
function priceInput(agorot: number): string {
  return agorot % 100 === 0 ? String(agorot / 100) : (agorot / 100).toFixed(2);
}

/** Create or edit a product (PRD-02). Owners and admins only; the page decides. */
export function ProductForm({ orgId, product, categories, units, orgPricesIncludeVat }: Props) {
  const action = product ? updateProductAction.bind(null, orgId, product.id) : createProductAction.bind(null, orgId);
  const [state, formAction] = useActionState<FormState, FormData>(action, null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const typed = failure?.values;
  const value = (name: string, stored: string | null | undefined) => typed?.[name] ?? stored ?? "";
  const [vatKind, setVatKind] = useState(value("vat_kind", product?.vatKind ?? "taxable"));
  const includesVat = typed ? typed.price_includes_vat === "on" : (product?.priceIncludesVat ?? orgPricesIncludeVat);
  const isActive = typed ? typed.is_active === "on" : (product?.isActive ?? true);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.message} />
      {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
      <TextField
        label="שם"
        name="name"
        required
        maxLength={PRODUCT_NAME_MAX}
        autoComplete="off"
        defaultValue={value("name", product?.name)}
        error={errors.name}
      />
      <TextareaField
        label="תיאור"
        hint="מופיע במסמכים, ואפשר לשנות אותו בכל שורה."
        name="description"
        rows={3}
        maxLength={PRODUCT_DESCRIPTION_MAX}
        defaultValue={value("description", product?.description)}
        error={errors.description}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="סוג" name="kind" required defaultValue={value("kind", product?.kind ?? "product")} error={errors.kind}>
          {PRODUCT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {PRODUCT_KIND_LABELS[kind]}
            </option>
          ))}
        </SelectField>
        <SelectField label="קטגוריה" name="category_id" defaultValue={value("category_id", product?.categoryId)} error={errors.category_id}>
          <option value="">בלי קטגוריה</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="מחיר מכירה (₪)"
          name="price_agorot"
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          defaultValue={value("price_agorot", product ? priceInput(product.priceAgorot) : "")}
          error={errors.price_agorot}
        />
        <SelectField label="יחידת מידה" name="unit_id" defaultValue={value("unit_id", product?.unitId)} error={errors.unit_id}>
          <option value="">בלי יחידה</option>
          {units.map((unit) => (
            <option key={unit.id} value={unit.id}>
              {unit.label}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label='מע"מ' name="vat_kind" required value={vatKind} onChange={(event) => setVatKind(event.target.value)} error={errors.vat_kind}>
          {VAT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {VAT_KIND_LABELS[kind]}
            </option>
          ))}
        </SelectField>
        <SelectField label="חיוב" name="billing" required defaultValue={value("billing", product?.billing ?? "one_time")} error={errors.billing}>
          {BILLINGS.map((billing) => (
            <option key={billing} value={billing}>
              {BILLING_LABELS[billing]}
            </option>
          ))}
        </SelectField>
      </div>
      {vatKind === "taxable" ? (
        <Checkbox
          name="price_includes_vat"
          label='המחיר כולל מע"מ'
          hint='בלי סימון, המחיר הוא לפני מע"מ והמע"מ מתווסף במסמך.'
          defaultChecked={includesVat}
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label='מק"ט'
          name="sku"
          dir="ltr"
          maxLength={PRODUCT_CODE_MAX}
          autoComplete="off"
          defaultValue={value("sku", product?.sku)}
          error={errors.sku}
        />
        <TextField
          label="ברקוד"
          name="barcode"
          dir="ltr"
          inputMode="numeric"
          maxLength={PRODUCT_CODE_MAX}
          autoComplete="off"
          defaultValue={value("barcode", product?.barcode)}
          error={errors.barcode}
        />
      </div>
      <TextField
        label="משך בדקות"
        hint="לשירות: משך ברירת המחדל ביומן ובקביעת תורים."
        name="duration_minutes"
        dir="ltr"
        inputMode="numeric"
        autoComplete="off"
        className="sm:max-w-48"
        max={DURATION_MAX}
        defaultValue={value("duration_minutes", product?.durationMinutes != null ? String(product.durationMinutes) : "")}
        error={errors.duration_minutes}
      />
      <Checkbox name="is_active" label="פעיל" hint="מוצר לא פעיל לא מוצע במסמכים חדשים." defaultChecked={isActive} />
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText={product ? "שומרים…" : "יוצרים מוצר…"}>{product ? "שמירה" : "יצירת מוצר"}</SubmitButton>
        {product ? null : (
          <ButtonLink href={productsPath(orgId)} variant="ghost">
            ביטול
          </ButtonLink>
        )}
      </div>
    </form>
  );
}

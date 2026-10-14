"use client";

import { startTransition as startAction, useActionState, useEffect, useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { Input, Label, TextField } from "@/components/ui/field";
import type { FormState } from "@/lib/action-result";
import { formatMoney } from "@/lib/format";

import { quickCreateProductAction, searchDealProductsAction, type ProductHit } from "../actions";

type Props = {
  orgId: string;
  dealId: string;
  // the customer's price list, whose tiers come with every hit (PL-03)
  listId: string | null;
  picked: ProductHit | null;
  onPick: (product: ProductHit | null) => void;
  // DLI-02: owners and admins of a writable business may make a product here
  canCreate: boolean;
  // the deal's VAT mode, for the quick product's price label
  includesVat: boolean;
};

/**
 * DLI-02: pick an offerable product (active, not archived) by name, SKU or barcode, or none (a free
 * line). The choice travels in the hidden input `product_id`; the search box itself sends nothing.
 */
export function DealProductPicker({ orgId, dealId, listId, picked, onPick, canCreate, includesVat }: Props) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [answered, setAnswered] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pending, startTransition] = useTransition();
  const inputId = useId();

  useEffect(() => {
    if (picked || creating) return;
    const q = query.trim();
    const timer = setTimeout(
      () => {
        startTransition(async () => {
          const found = await searchDealProductsAction(orgId, q, listId);
          setHits(found);
          setAnswered(q);
        });
      },
      q === "" ? 0 : 200,
    );
    return () => clearTimeout(timer);
  }, [query, orgId, listId, picked, creating]);

  const q = query.trim();
  const notFound = !pending && answered === q && hits.length === 0;

  if (picked) {
    return (
      <div>
        <input type="hidden" name="product_id" value={picked.id} />
        <p className="mb-1.5 block text-sm font-medium text-ink">מוצר</p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-3 py-2.5">
            <bdi>{picked.name}</bdi>
            {picked.sku ? (
              <span dir="ltr" className="ms-2 text-sm text-ink-soft">
                {picked.sku}
              </span>
            ) : null}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onPick(null)}>
            החלפה
          </Button>
        </div>
      </div>
    );
  }

  if (creating) {
    return (
      <QuickProduct
        orgId={orgId}
        dealId={dealId}
        includesVat={includesVat}
        initialName={q}
        onCancel={() => setCreating(false)}
        onCreated={(product) => {
          setCreating(false);
          onPick(product);
        }}
      />
    );
  }

  return (
    <div>
      <input type="hidden" name="product_id" value="" />
      <Label htmlFor={inputId}>מוצר מהקטלוג</Label>
      <Input
        id={inputId}
        type="search"
        value={query}
        autoComplete="off"
        placeholder='חיפוש לפי שם, מק"ט או ברקוד'
        aria-describedby={`${inputId}-hint`}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter in the search box must not send the line form
          if (event.key === "Enter") event.preventDefault();
        }}
      />
      <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-ink-soft">
        לא חובה. בלי מוצר זו שורה חופשית.
      </p>
      <p aria-live="polite" className="text-sm text-ink-soft empty:hidden">
        {notFound ? (q === "" ? "אין עדיין מוצרים פעילים בקטלוג." : "לא נמצא מוצר מתאים.") : ""}
      </p>
      {hits.length > 0 ? (
        <ul aria-label="מוצרים שנמצאו" className="mt-1 max-h-56 divide-y divide-line overflow-y-auto rounded-md border border-line">
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="flex min-h-11 w-full items-start justify-between gap-3 px-3 py-2 text-start hover:bg-canvas"
                onClick={() => {
                  onPick(hit);
                  setQuery("");
                  setHits([]);
                  setAnswered(null);
                }}
              >
                <span className="min-w-0">
                  <span className="block font-medium text-accent-strong">
                    <bdi>{hit.name}</bdi>
                  </span>
                  {hit.sku || hit.barcode ? (
                    <span dir="ltr" className="block text-sm text-ink-soft">
                      {[hit.sku, hit.barcode].filter(Boolean).join(" · ")}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-sm text-ink-soft">{formatMoney(hit.priceAgorot)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {canCreate ? (
        <Button variant="ghost" size="sm" className="mt-2" onClick={() => setCreating(true)}>
          מוצר חדש בקטלוג
        </Button>
      ) : null}
    </div>
  );
}

function QuickProduct({
  orgId,
  dealId,
  includesVat,
  initialName,
  onCancel,
  onCreated,
}: {
  orgId: string;
  dealId: string;
  includesVat: boolean;
  initialName: string;
  onCancel: () => void;
  onCreated: (product: ProductHit) => void;
}) {
  const [name, setName] = useState(initialName);
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [state, run, pending] = useActionState<FormState<ProductHit>, FormData>(async (prev, formData) => {
    const result = await quickCreateProductAction(orgId, dealId, prev, formData);
    if (result?.ok && result.data) onCreated(result.data);
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  // no nested <form>: this sits inside the line form, so its fields go to the action by hand
  function create() {
    const data = new FormData();
    data.set("name", name);
    data.set("sku", sku);
    data.set("price", price);
    startAction(() => run(data));
  }

  return (
    <fieldset
      className="space-y-3 rounded-md border border-line p-3"
      onKeyDown={(event) => {
        // Enter here makes the product; it must not send the line form around it
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          create();
        }
      }}
    >
      <legend className="px-1 text-sm font-medium text-ink">מוצר חדש בקטלוג</legend>
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextField label="שם המוצר" required value={name} onChange={(event) => setName(event.target.value)} error={failure?.fieldErrors?.name} autoFocus />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label='מק"ט' dir="ltr" autoComplete="off" value={sku} onChange={(event) => setSku(event.target.value)} error={failure?.fieldErrors?.sku} />
        <TextField
          label={includesVat ? 'מחיר (₪, כולל מע"מ)' : 'מחיר (₪, לפני מע"מ)'}
          dir="ltr"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
          error={failure?.fieldErrors?.price}
        />
      </div>
      <p className="text-sm text-ink-soft">שאר הפרטים נקבעים אחר כך בעמוד המוצר.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={create} loading={pending}>
          יצירה ובחירה
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          ביטול
        </Button>
      </div>
    </fieldset>
  );
}

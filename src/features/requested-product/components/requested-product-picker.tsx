"use client";

import { useEffect, useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/field";

import { searchRequestedProductsAction } from "../actions";
import type { RequestedProductHit } from "../queries";
import { REQUESTED_PRODUCT_FIELD } from "../schema";

export type RequestedProductChoice = { id: string; name: string; note?: string | null } | null;

type Props = {
  orgId: string;
  initial: RequestedProductChoice;
  error?: string;
};

/**
 * LEAD-04: pick the product the lead asked about, or none. The choice travels in the hidden input
 * `requested_product_id` ("" = none); the search box itself sends nothing. Only offerable products
 * (active, not archived) are found; a product stored earlier stays as it is until changed.
 */
export function RequestedProductPicker({ orgId, initial, error }: Props) {
  const [picked, setPicked] = useState<RequestedProductChoice>(initial);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RequestedProductHit[]>([]);
  // the query the hits answer, so "not found" is said only about a finished search
  const [answered, setAnswered] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const inputId = useId();
  const errorId = `${inputId}-error`;

  useEffect(() => {
    if (picked) return;
    const q = query.trim();
    const timer = setTimeout(() => {
      startTransition(async () => {
        const found = await searchRequestedProductsAction(orgId, q);
        setHits(found);
        setAnswered(q);
      });
    }, q === "" ? 0 : 200);
    return () => clearTimeout(timer);
  }, [query, orgId, picked]);

  const q = query.trim();
  const notFound = !pending && answered === q && hits.length === 0;

  return (
    <div>
      <input type="hidden" name={REQUESTED_PRODUCT_FIELD} value={picked?.id ?? ""} />
      {picked ? (
        <>
          <p className="mb-1.5 block text-sm font-medium text-ink">מוצר מבוקש</p>
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-3 py-2.5">
              <bdi>{picked.name}</bdi>
              {picked.note ? <span className="text-sm text-ink-soft"> ({picked.note})</span> : null}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setPicked(null)}>
              הסרה
            </Button>
          </div>
          {error ? (
            <p className="mt-1.5 text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <Label htmlFor={inputId}>מוצר מבוקש</Label>
          <Input
            id={inputId}
            type="search"
            value={query}
            autoComplete="off"
            placeholder="חיפוש לפי שם או מק״ט"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : `${inputId}-hint`}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Enter in the search box must not send the lead form
              if (event.key === "Enter") event.preventDefault();
            }}
          />
          {error ? (
            <p id={errorId} className="mt-1.5 text-sm text-danger">
              {error}
            </p>
          ) : (
            <p id={`${inputId}-hint`} className="mt-1.5 text-sm text-ink-soft">
              לא חובה. מוצרים פעילים מהקטלוג.
            </p>
          )}
          <p aria-live="polite" className="text-sm text-ink-soft empty:hidden">
            {notFound ? (q === "" ? "אין עדיין מוצרים פעילים בקטלוג." : "לא נמצא מוצר מתאים.") : ""}
          </p>
          {hits.length > 0 ? (
            <ul aria-label="מוצרים שנמצאו" className="mt-1 max-h-64 divide-y divide-line overflow-y-auto rounded-md border border-line">
              {hits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="block min-h-11 w-full px-3 py-2 text-start hover:bg-canvas"
                    onClick={() => {
                      setPicked({ id: hit.id, name: hit.name });
                      setQuery("");
                      setHits([]);
                      setAnswered(null);
                    }}
                  >
                    <span className="block font-medium text-accent-strong">
                      <bdi>{hit.name}</bdi>
                    </span>
                    {hit.sku ? (
                      <span dir="ltr" className="block text-sm text-ink-soft">
                        {hit.sku}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}

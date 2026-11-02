"use client";

import { useId, useState, useTransition } from "react";

import { FormError } from "@/components/ui/feedback";
import { Select } from "@/components/ui/field";

import { BUNDLE_DISPLAY_LABELS, BUNDLE_DISPLAYS, isBundleDisplay, type BundleDisplay, type BundlePartSnapshot } from "../bundle";
import { setLineBundleDisplayAction } from "../bundle-actions";
import { BundleItemsList } from "./bundle-items-list";

type Props = {
  display: BundleDisplay;
  parts: BundlePartSnapshot[];
  lineQuantity: number;
  // set when the person may change the line (a deal they edit, a draft quote or order)
  edit: { orgId: string; kind: "deal" | "quote" | "order"; parentId: string; lineId: string } | null;
};

/**
 * PRD-09: a bundle line's display on the document, "שורה אחת" or "מפורט", saved at once; an itemised line lists its
 * parts under it.
 */
export function BundleLineControl({ display, parts, lineQuantity, edit }: Props) {
  const [value, setValue] = useState<BundleDisplay>(display);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const id = useId();

  function change(next: string) {
    if (!edit || !isBundleDisplay(next)) return;
    const before = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const outcome = await setLineBundleDisplayAction(edit.orgId, edit.kind, edit.parentId, edit.lineId, next);
      if (!outcome.ok) {
        setValue(before);
        setError(outcome.message);
      }
    });
  }

  return (
    <div className="mt-1 space-y-1">
      {edit ? (
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <label htmlFor={id} className="text-sm text-ink-soft">
            חבילה במסמך
          </label>
          <Select id={id} controlSize="sm" value={value} disabled={pending} onChange={(event) => change(event.target.value)} className="w-auto">
            {BUNDLE_DISPLAYS.map((option) => (
              <option key={option} value={option}>
                {BUNDLE_DISPLAY_LABELS[option]}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <p className="text-sm text-ink-soft">חבילה, {value === "itemised" ? "מוצגת מפורטת" : "מוצגת כשורה אחת"}</p>
      )}
      <FormError message={error} />
      {value === "itemised" ? <BundleItemsList parts={parts} lineQuantity={lineQuantity} /> : null}
    </div>
  );
}

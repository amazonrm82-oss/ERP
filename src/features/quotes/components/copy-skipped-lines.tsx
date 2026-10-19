"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { formatMoney, formatNumber } from "@/lib/format";

import { addSkippedLineAction } from "../actions";

type Item = { id: string; name: string; quantity: number; unitPriceAgorot: number; added: boolean };

type Props = { orgId: string; draftId: string; sourceId: string; items: Item[] };

/**
 * QUO-15 (owner, 19 October 2026): the lines a copy left out, each with "להוסיף כשורה חופשית", which adds it to this draft
 * with its name, quantity and price (the person's own line, under the normal rules).
 */
export function CopySkippedLines({ orgId, draftId, sourceId, items }: Props) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function add(item: Item) {
    setError(null);
    setBusy(item.id);
    startTransition(async () => {
      const result = await addSkippedLineAction(orgId, draftId, sourceId, item.id);
      if (!result.ok) setError(result.message);
      setBusy(null);
    });
  }

  return (
    <div className="space-y-2 rounded-md border border-line bg-surface p-3 text-sm">
      <p className="font-medium">אפשר להוסיף את השורות שלא הועתקו כשורות חופשיות:</p>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words">
              <bdi>{item.name}</bdi>{" "}
              <span className="text-ink-soft">
                (<span dir="ltr" className="tabular-nums">{formatNumber(item.quantity)}</span> × <span className="tabular-nums">{formatMoney(item.unitPriceAgorot)}</span>)
              </span>
            </span>
            {item.added ? (
              <span className="text-ink-soft">נוספה להצעה</span>
            ) : (
              <Button variant="secondary" size="sm" disabled={pending} onClick={() => add(item)}>
                {busy === item.id ? "מוסיפים…" : "להוסיף כשורה חופשית"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {error ? <FormError message={error} /> : null}
    </div>
  );
}

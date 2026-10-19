"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { PlusIcon } from "@/components/ui/icons";

import { createQuoteAction } from "../actions";

type Props = {
  orgId: string;
  source: { kind: "deal" | "contact"; id: string };
  // QUO-04: the business's templates; with none (and no deal lines) the button makes an empty quote at once
  templates?: { id: string; name: string }[];
  // DLI-05: how many product lines the deal has; with any, the window offers the quote made from them first
  dealLines?: number;
};

/** QUO-01: a new draft quote for this deal or contact, empty or from a template (QUO-04); the editor opens. */
export function NewQuoteButton({ orgId, source, templates = [], dealLines = 0 }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const fromDeal = source.kind === "deal" && dealLines > 0;
  const asks = templates.length > 0 || fromDeal;

  function create(templateId: string | null, copyDeal = false) {
    setError(null);
    startTransition(async () => {
      const outcome = await createQuoteAction(orgId, source, templateId, copyDeal);
      // success navigates to the editor; only a refusal comes back
      if (outcome && !outcome.ok) setError(outcome.message);
    });
  }

  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        size="sm"
        className="print:hidden"
        disabled={pending}
        onClick={() => (asks ? setOpen(true) : create(null))}
      >
        <PlusIcon className="size-4" />
        {pending ? "יוצרים…" : "הצעה חדשה"}
      </Button>
      {open ? null : <FormError message={error} />}
      {asks ? (
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title="הצעה חדשה"
          description={fromDeal ? "אפשר להתחיל משורות העסקה, מהצעה ריקה או מתבנית שמורה." : "אפשר להתחיל מהצעה ריקה או מתבנית שמורה."}
        >
          <div className="space-y-3">
            <FormError message={error} />
            <ul className="space-y-2">
              {fromDeal ? (
                <li>
                  <Button className="w-full justify-start" disabled={pending} onClick={() => create(null, true)}>
                    {dealLines === 1 ? "משורת העסקה (שורה אחת)" : `משורות העסקה (${dealLines} שורות)`}
                  </Button>
                </li>
              ) : null}
              <li>
                <Button variant="secondary" className="w-full justify-start" disabled={pending} onClick={() => create(null)}>
                  הצעה ריקה
                </Button>
              </li>
              {templates.map((template) => (
                <li key={template.id}>
                  <Button variant="ghost" className="w-full justify-start" disabled={pending} onClick={() => create(template.id)}>
                    <bdi className="truncate">{template.name}</bdi>
                  </Button>
                </li>
              ))}
            </ul>
            {pending ? <p className="text-sm text-ink-soft">יוצרים את ההצעה…</p> : null}
          </div>
        </Dialog>
      ) : null}
    </span>
  );
}

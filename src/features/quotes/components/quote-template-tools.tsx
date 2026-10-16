"use client";

import { useActionState, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { applyQuoteTemplateAction, saveQuoteAsTemplateAction } from "../template-actions";
import { QUOTE_TEMPLATE_NAME_MAX } from "../templates";

type Props = {
  orgId: string;
  quoteId: string;
  quoteTitle: string;
  templates: { id: string; name: string }[];
  // the person may edit this draft (add its lines)
  canApply: boolean;
  // owners and admins of a writable business with quotes in the plan (RLS decides again)
  canSave: boolean;
};

/**
 * QUO-04 in the quote editor: "מתבנית" adds a template's lines (and fills empty notes and terms);
 * "שמירה כתבנית" saves this quote's lines, notes and terms as a new template.
 */
export function QuoteTemplateTools({ orgId, quoteId, quoteTitle, templates, canApply, canSave }: Props) {
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const showApply = canApply && templates.length > 0;
  if (!showApply && !canSave) return null;

  function apply(templateId: string) {
    setMessage(null);
    startTransition(async () => {
      const outcome = await applyQuoteTemplateAction(orgId, quoteId, templateId);
      setMessage({ ok: outcome.ok, text: outcome.message ?? "" });
      if (outcome.ok) setPicking(false);
    });
  }

  return (
    <div className="space-y-2 print:hidden">
      <div className="flex flex-wrap gap-2">
        {showApply ? (
          <Button variant="secondary" size="sm" onClick={() => setPicking(true)}>
            מתבנית
          </Button>
        ) : null}
        {canSave ? (
          <Button variant="ghost" size="sm" onClick={() => setSaving(true)}>
            שמירה כתבנית
          </Button>
        ) : null}
      </div>
      {message && !picking ? message.ok ? <FormNotice message={message.text} /> : <FormError message={message.text} /> : null}
      {showApply ? (
        <Dialog open={picking} onClose={() => setPicking(false)} title="הוספה מתבנית" description="השורות של התבנית נוספות בסוף ההצעה.">
          <div className="space-y-3">
            {message && !message.ok ? <FormError message={message.text} /> : null}
            <ul className="space-y-2">
              {templates.map((template) => (
                <li key={template.id}>
                  <Button variant="ghost" className="w-full justify-start" disabled={pending} onClick={() => apply(template.id)}>
                    <bdi className="truncate">{template.name}</bdi>
                  </Button>
                </li>
              ))}
            </ul>
            {pending ? <p className="text-sm text-ink-soft">מוסיפים…</p> : null}
          </div>
        </Dialog>
      ) : null}
      {canSave ? (
        <Dialog open={saving} onClose={() => setSaving(false)} title="שמירה כתבנית" description="השורות, ההערות והתנאים של ההצעה נשמרים לשימוש חוזר.">
          {saving ? <SaveForm orgId={orgId} quoteId={quoteId} defaultName={quoteTitle} onDone={() => setSaving(false)} /> : null}
        </Dialog>
      ) : null}
    </div>
  );
}

function SaveForm({ orgId, quoteId, defaultName, onDone }: { orgId: string; quoteId: string; defaultName: string; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(saveQuoteAsTemplateAction.bind(null, orgId, quoteId), null);
  const failure = state && !state.ok ? state : null;
  if (state?.ok) {
    return (
      <div className="space-y-3">
        <FormNotice message={state.message ?? "התבנית נשמרה."} />
        <Button variant="secondary" onClick={onDone}>
          סגירה
        </Button>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextField
        label="שם התבנית"
        name="name"
        required
        maxLength={QUOTE_TEMPLATE_NAME_MAX}
        defaultValue={failure?.values?.name ?? Array.from(defaultName).slice(0, QUOTE_TEMPLATE_NAME_MAX).join("")}
        hint="מוצר שהמחיר שלו נלקח מהקטלוג יקבל את המחיר של הלקוח הבא. מחיר שהוקלד נשמר כמו שהוא."
        error={failure?.fieldErrors?.name}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">שמירת התבנית</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

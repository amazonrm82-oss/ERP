"use client";

import { useActionState, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";
import { formatDate } from "@/lib/format";

import { deleteQuoteTemplateAction, renameQuoteTemplateAction } from "../template-actions";
import type { QuoteTemplateSummary } from "../template-server";
import { QUOTE_TEMPLATE_NAME_MAX } from "../templates";

/** QUO-04: the templates, with rename and delete for owners and admins. */
export function QuoteTemplatesList({ orgId, templates, canEdit }: { orgId: string; templates: QuoteTemplateSummary[]; canEdit: boolean }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  if (templates.length === 0) {
    return <p className="text-md text-ink-soft">עוד אין תבניות.</p>;
  }
  return (
    <Card aria-label="תבניות הצעת מחיר">
      <CardBody>
        <ul className="divide-y divide-line">
          {templates.map((template) => (
            <li key={template.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
              {renaming === template.id ? (
                <RenameForm orgId={orgId} template={template} onDone={() => setRenaming(null)} />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">
                      <bdi>{template.name}</bdi>
                    </p>
                    <p className="text-sm text-ink-soft">נשמרה {formatDate(template.createdAt)}</p>
                    {template.notes ? <p className="line-clamp-2 text-sm whitespace-pre-line text-ink-soft">{template.notes}</p> : null}
                  </div>
                  {canEdit ? (
                    <span className="flex flex-wrap gap-1">
                      <Button variant="ghost" size="sm" onClick={() => setRenaming(template.id)} aria-label={`שינוי שם: ${template.name}`}>
                        שינוי שם
                      </Button>
                      <ConfirmButton
                        title={`למחוק את התבנית "${template.name}"?`}
                        description="הצעות שכבר נוצרו ממנה לא משתנות."
                        confirmLabel="מחיקה"
                        action={() => deleteQuoteTemplateAction(orgId, template.id)}
                      >
                        מחיקה
                      </ConfirmButton>
                    </span>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

function RenameForm({ orgId, template, onDone }: { orgId: string; template: QuoteTemplateSummary; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await renameQuoteTemplateAction(orgId, template.id, prev, formData);
    if (result?.ok) onDone();
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      <TextField
        label="שם התבנית"
        name="name"
        required
        maxLength={QUOTE_TEMPLATE_NAME_MAX}
        defaultValue={failure?.values?.name ?? template.name}
        error={failure?.fieldErrors?.name}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
        <Button variant="ghost" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

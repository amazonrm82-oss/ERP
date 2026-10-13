"use client";

import { useActionState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addTemplateAction, deleteTemplateAction, moveTemplateAction, updateTemplateAction } from "../actions";
import type { WhatsappTemplate } from "../queries";
import { MEETING_REMINDER_KIND, TEMPLATE_BODY_MAX, TEMPLATE_NAME_MAX } from "../templates";

/** WA-01: the organization's WhatsApp templates: edit, reorder and delete. */
export function TemplateList({ orgId, templates, editable }: { orgId: string; templates: WhatsappTemplate[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {templates.map((template, index) => (
        <TemplateRow
          key={`${template.id}-${template.name}-${template.body}`}
          orgId={orgId}
          template={template}
          editable={editable}
          isFirst={index === 0}
          isLast={index === templates.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; template: WhatsappTemplate; editable: boolean; isFirst: boolean; isLast: boolean };

function ReminderBadge({ template }: { template: WhatsappTemplate }) {
  return template.kind === MEETING_REMINDER_KIND ? <Badge tone="accent">מוצעת בתזכורת לפגישה</Badge> : null;
}

function TemplateRow({ orgId, template, editable, isFirst, isLast }: RowProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateTemplateAction.bind(null, orgId, template.id), null);
  const failure = state && !state.ok ? state : null;

  if (!editable) {
    return (
      <li className="space-y-1 px-4 py-3 sm:px-5">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          <span className="min-w-0 break-words">{template.name}</span>
          <ReminderBadge template={template} />
        </p>
        <p className="break-words whitespace-pre-wrap text-md text-ink-soft">{template.body}</p>
      </li>
    );
  }

  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <form action={formAction} className="space-y-3" noValidate>
        <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
        <TextField
          label="שם התבנית"
          name="name"
          required
          maxLength={TEMPLATE_NAME_MAX}
          autoComplete="off"
          defaultValue={failure?.values?.name ?? template.name}
          error={failure?.fieldErrors?.name}
        />
        <TextareaField
          label="נוסח ההודעה"
          name="body"
          required
          rows={4}
          maxLength={TEMPLATE_BODY_MAX}
          defaultValue={failure?.values?.body ?? template.body}
          error={failure?.fieldErrors?.body}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" variant="secondary" pendingText="שומרים…">
            שמירה
            <span className="sr-only">: {template.name}</span>
          </SubmitButton>
          <ReminderBadge template={template} />
          {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
        </div>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm text-ink-soft">
        <ActionButton action={moveTemplateAction.bind(null, orgId, template.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={template.name} disabled={isFirst}>
          הזזה למעלה
        </ActionButton>
        <ActionButton action={moveTemplateAction.bind(null, orgId, template.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={template.name} disabled={isLast}>
          הזזה למטה
        </ActionButton>
        <ActionButton
          action={deleteTemplateAction.bind(null, orgId, template.id)}
          pendingText="מוחקים…"
          variant="danger-ghost"
          srLabel={template.name}
          confirm={`למחוק את התבנית "${template.name}"? הודעות שכבר נשלחו נשארות בציר הזמן.`}
        >
          מחיקה
        </ActionButton>
      </div>
    </li>
  );
}

export function AddTemplateForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addTemplateAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate key={state?.ok ? "saved" : "editing"}>
      <h3 className="font-semibold">תבנית חדשה</h3>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="שם התבנית"
        name="name"
        required
        maxLength={TEMPLATE_NAME_MAX}
        autoComplete="off"
        placeholder="למשל: הצעת מחיר נשלחה"
        defaultValue={failure?.values?.name}
        error={failure?.fieldErrors?.name}
      />
      <TextareaField
        label="נוסח ההודעה"
        name="body"
        required
        rows={4}
        maxLength={TEMPLATE_BODY_MAX}
        placeholder="שלום {שם פרטי}, ..."
        defaultValue={failure?.values?.body}
        error={failure?.fieldErrors?.body}
      />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת תבנית
      </SubmitButton>
    </form>
  );
}

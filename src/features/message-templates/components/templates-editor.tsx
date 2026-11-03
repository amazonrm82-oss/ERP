"use client";

import { useActionState, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { MessageChannel, MessageType } from "@/features/messaging/providers/types";
import type { FormState } from "@/lib/action-result";

import { addMessageTemplateAction, deleteMessageTemplateAction, updateMessageTemplateAction } from "../actions";
import type { MessageTemplate } from "../queries";
import {
  isServiceType,
  MESSAGE_TEMPLATE_BODY_MAX,
  MESSAGE_TEMPLATE_NAME_MAX,
  MESSAGE_TEMPLATE_SUBJECT_MAX,
  MESSAGE_TYPE_LABELS,
  MESSAGE_TYPE_OPTIONS,
  smsLengthWarning,
  TEMPLATE_CHANNEL_LABELS,
  TEMPLATE_CHANNELS,
  TEMPLATE_LOCALE_LABELS,
  TEMPLATE_LOCALES,
  type TemplateLocale,
} from "../templates";

/** The type's badge: service or marketing, with the type's name. */
export function TypeBadge({ type }: { type: MessageType }) {
  return (
    <Badge tone={isServiceType(type) ? "accent" : "warning"}>{`${isServiceType(type) ? "שירות" : "שיווק"}: ${MESSAGE_TYPE_LABELS[type]}`}</Badge>
  );
}

function localeName(locale: string): string {
  return (TEMPLATE_LOCALE_LABELS as Record<string, string>)[locale] ?? locale;
}

type Values = {
  name: string;
  channel: MessageChannel;
  messageType: MessageType;
  subject: string;
  body: string;
  locale: string;
  isActive: boolean;
};

const EMPTY: Values = {
  name: "",
  channel: "sms",
  messageType: "marketing",
  subject: "",
  body: "",
  locale: "he",
  isActive: true,
};

/** The fields of one template (new or existing). The subject shows for email only; an SMS shows its length warning. */
function TemplateFields({ initial, failure }: { initial: Values; failure: Extract<FormState, { ok: false }> | null }) {
  const values = failure?.values;
  const [channel, setChannel] = useState<string>(values?.channel ?? initial.channel);
  const [body, setBody] = useState<string>(values?.body ?? initial.body);
  const [type, setType] = useState<string>(values?.message_type ?? initial.messageType);
  const errors = failure?.fieldErrors;
  const smsWarning = channel === "sms" ? smsLengthWarning(body.trim()) : null;
  const typeIsService = MESSAGE_TYPE_OPTIONS.some((option) => option.value === type && isServiceType(option.value));
  return (
    <div className="space-y-3">
      <TextField
        label="שם התבנית"
        name="name"
        required
        maxLength={MESSAGE_TEMPLATE_NAME_MAX}
        autoComplete="off"
        defaultValue={values?.name ?? initial.name}
        error={errors?.name}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <SelectField
          label="ערוץ"
          name="channel"
          required
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          error={errors?.channel}
        >
          {TEMPLATE_CHANNELS.map((value) => (
            <option key={value} value={value}>
              {TEMPLATE_CHANNEL_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="סוג ההודעה"
          name="message_type"
          required
          value={type}
          onChange={(event) => setType(event.target.value)}
          error={errors?.message_type}
          hint={typeIsService ? "הודעת שירות" : 'הודעה שיווקית: נשלחת רק למי שהסכים לקבל. המערכת מוסיפה לבד "פרסומת", את פרטי העסק ושורת הסרה.'}
        >
          {MESSAGE_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        <SelectField label="שפה" name="locale" required defaultValue={values?.locale ?? initial.locale} error={errors?.locale}>
          {TEMPLATE_LOCALES.map((value: TemplateLocale) => (
            <option key={value} value={value}>
              {TEMPLATE_LOCALE_LABELS[value]}
            </option>
          ))}
        </SelectField>
      </div>
      {channel === "email" ? (
        <TextField
          label="נושא"
          name="subject"
          required
          maxLength={MESSAGE_TEMPLATE_SUBJECT_MAX}
          autoComplete="off"
          defaultValue={values?.subject ?? initial.subject}
          error={errors?.subject}
        />
      ) : null}
      <TextareaField
        label="נוסח ההודעה"
        name="body"
        required
        rows={5}
        maxLength={MESSAGE_TEMPLATE_BODY_MAX}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="שלום {שם פרטי}, ..."
        error={errors?.body}
        hint={smsWarning ?? undefined}
      />
      <Checkbox
        label="פעילה"
        name="is_active"
        defaultChecked={values ? values.is_active === "on" : initial.isActive}
        hint="תבנית לא פעילה נשמרת, אבל לא מוצעת לשליחה."
      />
    </div>
  );
}

/** MSG-02: the business's message templates: edit and delete (owners and admins), or read. */
export function MessageTemplateList({ orgId, templates, editable }: { orgId: string; templates: MessageTemplate[]; editable: boolean }) {
  return (
    <ol className="divide-y divide-line">
      {templates.map((template) =>
        editable ? (
          <EditableRow key={`${template.id}-${template.name}-${template.body}-${template.subject}`} orgId={orgId} template={template} />
        ) : (
          <ReadRow key={template.id} template={template} />
        ),
      )}
    </ol>
  );
}

function RowHeading({ template }: { template: MessageTemplate }) {
  return (
    <p className="flex flex-wrap items-center gap-2 font-medium">
      <span className="min-w-0 break-words">{template.name}</span>
      <Badge>{TEMPLATE_CHANNEL_LABELS[template.channel]}</Badge>
      <TypeBadge type={template.messageType} />
      <span className="text-sm font-normal text-ink-soft">{localeName(template.locale)}</span>
      {template.isActive ? null : <Badge tone="neutral">לא פעילה</Badge>}
    </p>
  );
}

function ReadRow({ template }: { template: MessageTemplate }) {
  return (
    <li className="space-y-1 px-4 py-3 sm:px-5">
      <RowHeading template={template} />
      {template.subject ? <p className="text-md text-ink">נושא: {template.subject}</p> : null}
      <p className="break-words whitespace-pre-wrap text-md text-ink-soft">{template.body}</p>
    </li>
  );
}

function EditableRow({ orgId, template }: { orgId: string; template: MessageTemplate }) {
  const [state, formAction] = useActionState<FormState, FormData>(updateMessageTemplateAction.bind(null, orgId, template.id), null);
  const failure = state && !state.ok ? state : null;
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <RowHeading template={template} />
      <form action={formAction} className="space-y-3" noValidate>
        <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
        <TemplateFields
          failure={failure}
          initial={{
            name: template.name,
            channel: template.channel,
            messageType: template.messageType,
            subject: template.subject ?? "",
            body: template.body,
            locale: template.locale,
            isActive: template.isActive,
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" variant="secondary" pendingText="שומרים…">
            שמירה
            <span className="sr-only">: {template.name}</span>
          </SubmitButton>
          {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
        </div>
      </form>
      <ActionButton
        action={deleteMessageTemplateAction.bind(null, orgId, template.id)}
        pendingText="מוחקים…"
        variant="danger-ghost"
        srLabel={template.name}
        confirm={`למחוק את התבנית "${template.name}"?`}
      >
        מחיקה
      </ActionButton>
    </li>
  );
}

export function AddMessageTemplateForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addMessageTemplateAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate key={state?.ok ? "saved" : "editing"}>
      <h3 className="font-semibold">תבנית חדשה</h3>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TemplateFields initial={EMPTY} failure={failure} />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת תבנית
      </SubmitButton>
    </form>
  );
}

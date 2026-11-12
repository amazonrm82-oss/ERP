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
import { editedTemplateProblemText, templateProblemText, type OwnAddresses } from "../service-rule";
import {
  isInstantReplyNoticeTemplate,
  isServiceType,
  isSystemOnlyType,
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

/** Owner (90) ג: why a service template will not be sent; nothing when it may be. */
export function SendProblem({ message, live = false }: { message: string | null; live?: boolean }) {
  if (!message) return null;
  return (
    <p role={live ? undefined : "status"} className="rounded-md bg-warning-soft px-3 py-2.5 text-sm break-words text-warning">
      {message}
    </p>
  );
}

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
  // SGN-03 delta review D1: the stored mark of a system template (never written by the form)
  noticeKind?: string | null;
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
function TemplateFields({
  initial,
  failure,
  own,
}: {
  initial: Values;
  failure: Extract<FormState, { ok: false }> | null;
  own: OwnAddresses;
}) {
  const values = failure?.values;
  const [channel, setChannel] = useState<string>(values?.channel ?? initial.channel);
  const [body, setBody] = useState<string>(values?.body ?? initial.body);
  const [type, setType] = useState<string>(values?.message_type ?? initial.messageType);
  const [subject, setSubject] = useState<string>(values?.subject ?? initial.subject);
  const errors = failure?.fieldErrors;
  // SPD-04 review: the system's instant replies keep their channel and type (the database refuses a change)
  const kindFixed = isInstantReplyNoticeTemplate(initial.noticeKind);
  const smsWarning = channel === "sms" ? smsLengthWarning(body.trim()) : null;
  const picked = MESSAGE_TYPE_OPTIONS.find((option) => option.value === type)?.value;
  const typeIsService = picked !== undefined && isServiceType(picked);
  const pickedChannel = TEMPLATE_CHANNELS.find((value) => value === channel);
  // shown while typing; saving is never refused (owner (90) ג: checked before every send)
  const problem =
    picked && pickedChannel
      ? editedTemplateProblemText(
          {
            channel: pickedChannel,
            messageType: picked,
            subject: pickedChannel === "email" ? subject.trim() : null,
            body: body.replace(/\r\n?/g, "\n").trim(),
          },
          initial.noticeKind,
          own,
        )
      : null;
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
      {kindFixed ? (
        <p className="text-sm text-ink-soft">
          {TEMPLATE_CHANNEL_LABELS[initial.channel]} · {MESSAGE_TYPE_OPTIONS.find((option) => option.value === initial.messageType)?.label}. בתבנית
          של המערכת אפשר לשנות את הנוסח ולכבות אותה, בלי לשנות ערוץ או סוג.
          <input type="hidden" name="channel" value={initial.channel} />
          <input type="hidden" name="message_type" value={initial.messageType} />
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-3">
        {kindFixed ? null : (
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
        )}
        {kindFixed ? null : (
        <SelectField
          label="סוג ההודעה"
          name="message_type"
          required
          value={type}
          onChange={(event) => setType(event.target.value)}
          error={errors?.message_type}
          hint={typeIsService ? "הודעת שירות" : 'הודעה שיווקית: נשלחת רק למי שהסכים לקבל. המערכת מוסיפה לבד "פרסומת", את פרטי העסק ושורת הסרה.'}
        >
          {/* RET-02: a system-only type (the review request) is shown only on its own template, and nothing else is offered there */}
          {MESSAGE_TYPE_OPTIONS.filter((option) =>
            isSystemOnlyType(initial.messageType) ? option.value === initial.messageType : !isSystemOnlyType(option.value),
          ).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectField>
        )}
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
          value={subject}
          onChange={(event) => setSubject(event.target.value)}
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
      <SendProblem message={problem} live />
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
export function MessageTemplateList({
  orgId,
  templates,
  editable,
  own,
}: {
  orgId: string;
  templates: MessageTemplate[];
  editable: boolean;
  /** owner (97): the business's own domain, allowed in a service message */
  own: OwnAddresses;
}) {
  return (
    <ol className="divide-y divide-line">
      {templates.map((template) =>
        editable ? (
          <EditableRow key={`${template.id}-${template.name}-${template.body}-${template.subject}-${template.messageType}-${template.channel}`} orgId={orgId} template={template} own={own} />
        ) : (
          <ReadRow key={template.id} template={template} own={own} />
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
      {/* a template the system sends itself (notice_kind): never offered on a card or in a rule */}
      {template.noticeKind ? <Badge tone="neutral">נשלחת אוטומטית</Badge> : null}
      {template.isActive ? null : <Badge tone="neutral">לא פעילה</Badge>}
    </p>
  );
}

function storedProblem(template: MessageTemplate, own: OwnAddresses): string | null {
  return templateProblemText({ ...template, ...own });
}

function ReadRow({ template, own }: { template: MessageTemplate; own: OwnAddresses }) {
  return (
    <li className="space-y-1 px-4 py-3 sm:px-5">
      <RowHeading template={template} />
      <SendProblem message={storedProblem(template, own)} />
      {template.subject ? <p className="text-md text-ink">נושא: {template.subject}</p> : null}
      <p className="break-words whitespace-pre-wrap text-md text-ink-soft">{template.body}</p>
    </li>
  );
}

function EditableRow({ orgId, template, own }: { orgId: string; template: MessageTemplate; own: OwnAddresses }) {
  const [state, formAction] = useActionState<FormState, FormData>(updateMessageTemplateAction.bind(null, orgId, template.id), null);
  const failure = state && !state.ok ? state : null;
  // SPD-04, owner (282) ב: the system's instant reply templates are edited or switched off, never deleted
  const kept = isInstantReplyNoticeTemplate(template.noticeKind);
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <RowHeading template={template} />
      <SendProblem message={storedProblem(template, own)} />
      <form action={formAction} className="space-y-3" noValidate>
        <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
        <TemplateFields
          failure={failure}
          own={own}
          initial={{
            name: template.name,
            channel: template.channel,
            messageType: template.messageType,
            subject: template.subject ?? "",
            body: template.body,
            locale: template.locale,
            isActive: template.isActive,
            noticeKind: template.noticeKind,
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton size="sm" variant="secondary" pendingText="שומרים…">
            שמירה
            <span className="sr-only">: {template.name}</span>
          </SubmitButton>
          {state?.ok && state.message ? (
            state.message === "התבנית נשמרה." ? <FormNotice message={state.message} /> : <SendProblem message={state.message} />
          ) : null}
        </div>
      </form>
      {kept ? null : (
      <ActionButton
        action={deleteMessageTemplateAction.bind(null, orgId, template.id)}
        pendingText="מוחקים…"
        variant="danger-ghost"
        srLabel={template.name}
        confirm={`למחוק את התבנית "${template.name}"?`}
      >
        מחיקה
      </ActionButton>
      )}
    </li>
  );
}

export function AddMessageTemplateForm({ orgId, own }: { orgId: string; own: OwnAddresses }) {
  const [state, formAction] = useActionState<FormState, FormData>(addMessageTemplateAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate key={state?.ok ? "saved" : "editing"}>
      <h3 className="font-semibold">תבנית חדשה</h3>
      {state?.ok && state.message ? <SendProblem message={state.message} /> : null}
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TemplateFields initial={EMPTY} failure={failure} own={own} />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת תבנית
      </SubmitButton>
    </form>
  );
}

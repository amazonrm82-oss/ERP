"use client";

import { useActionState, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { NoteText } from "@/features/activities/components/note-text";
import type { FormState } from "@/lib/action-result";

import { addDocumentTemplateAction, deleteDocumentTemplateAction, switchOffDocumentTemplateAction, updateDocumentTemplateAction } from "../actions";
import { DOCUMENT_BUSINESS_FIELDS, DOCUMENT_RECORD_FIELDS, DOCUMENT_RECORD_TYPES, isDocumentRecordType, type DocumentRecordType } from "../fields";
import type { DocumentTemplate } from "../queries";
import { DOCUMENT_KIND_LABELS, DOCUMENT_KINDS, DOCUMENT_TEMPLATE_BODY_MAX, DOCUMENT_TEMPLATE_NAME_MAX, type DocumentKind } from "../templates";

/** The record type in the business's own words (FLD-10). */
export type RecordTypeLabels = Record<DocumentRecordType, string>;

export const DRAFT_LINE = "טיוטה: נוסח לדוגמה שעורך דין עוד לא בדק. מומלץ לבדוק אותו לפני שמשתמשים בו.";
export const HEALTH_LINE = "הצהרת בריאות עשויה להכיל מידע רפואי רגיש. בשלב הזה המערכת לא שומרת מסמכים ממולאים, רק את הנוסח.";

/** The merge fields of one record type: the business's, then the record's own. */
export function FieldList({ type, labels }: { type: DocumentRecordType; labels: RecordTypeLabels }) {
  const groups = [
    { title: "פרטי העסק", fields: DOCUMENT_BUSINESS_FIELDS },
    { title: `פרטי ה${labels[type]}`, fields: DOCUMENT_RECORD_FIELDS[type] },
  ];
  return (
    <details className="rounded-md border border-line px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium text-ink">השדות שאפשר לכתוב בנוסח</summary>
      <div className="mt-2 space-y-3">
        {groups.map((group) => (
          <div key={group.title} className="space-y-1">
            <p className="font-medium text-ink">{group.title}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-ink-soft">
              {group.fields.map((field) => (
                <div key={field.name} className="contents">
                  <dt className="font-medium text-ink">{`{${field.name}}`}</dt>
                  <dd>{field.label}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </details>
  );
}

type Values = { name: string; kind: DocumentKind; recordType: DocumentRecordType; body: string; isActive: boolean };

const EMPTY: Values = { name: "", kind: "contract", recordType: "contact", body: "", isActive: true };

function TemplateFields({
  initial,
  failure,
  labels,
}: {
  initial: Values;
  failure: Extract<FormState, { ok: false }> | null;
  labels: RecordTypeLabels;
}) {
  const values = failure?.values;
  const errors = failure?.fieldErrors;
  const [recordType, setRecordType] = useState<string>(values?.record_type ?? initial.recordType);
  const [kind, setKind] = useState<string>(values?.kind ?? initial.kind);
  const shownType: DocumentRecordType = isDocumentRecordType(recordType) ? recordType : initial.recordType;
  return (
    <div className="space-y-3">
      <TextField
        label="שם התבנית"
        name="name"
        required
        maxLength={DOCUMENT_TEMPLATE_NAME_MAX}
        autoComplete="off"
        defaultValue={values?.name ?? initial.name}
        error={errors?.name}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField label="סוג המסמך" name="kind" required value={kind} onChange={(event) => setKind(event.target.value)} error={errors?.kind}>
          {DOCUMENT_KINDS.map((value) => (
            <option key={value} value={value}>
              {DOCUMENT_KIND_LABELS[value]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="מתמלא מתוך"
          name="record_type"
          required
          value={recordType}
          onChange={(event) => setRecordType(event.target.value)}
          error={errors?.record_type}
          hint="השדות שבנוסח נלקחים מהרשומה הזאת."
        >
          {DOCUMENT_RECORD_TYPES.map((value) => (
            <option key={value} value={value}>
              {labels[value]}
            </option>
          ))}
        </SelectField>
      </div>
      {kind === "health_declaration" ? <p className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">{HEALTH_LINE}</p> : null}
      <TextareaField
        label="נוסח המסמך"
        name="body"
        required
        rows={12}
        maxLength={DOCUMENT_TEMPLATE_BODY_MAX}
        defaultValue={values?.body ?? initial.body}
        placeholder={"**כותרת**\n\nנערך ביום {תאריך היום} בין {שם העסק} לבין {שם מלא}."}
        error={errors?.body}
        hint="**מודגש**, שורה שמתחילה ב-״- ״ לרשימה, ״1. ״ לרשימה ממוספרת. שדות כותבים בסוגריים מסולסלים, בדיוק כמו ברשימה."
      />
      <FieldList type={shownType} labels={labels} />
      <Checkbox
        label="פעילה"
        name="is_active"
        defaultChecked={values ? values.is_active === "on" : initial.isActive}
        hint="תבנית לא פעילה נשמרת, אבל לא מוצעת להפקת מסמך."
      />
    </div>
  );
}

function RowHeading({ template, labels }: { template: DocumentTemplate; labels: RecordTypeLabels }) {
  return (
    <span className="flex flex-wrap items-center gap-2 font-medium">
      <span className="min-w-0 break-words">{template.name}</span>
      <Badge>{DOCUMENT_KIND_LABELS[template.kind]}</Badge>
      <span className="text-sm font-normal text-ink-soft">{`מתמלא מתוך: ${labels[template.recordType]}`}</span>
      {template.draftWording ? <Badge tone="warning">טיוטה</Badge> : null}
      {template.isActive ? null : <Badge tone="neutral">לא פעילה</Badge>}
    </span>
  );
}

function Notes({ template }: { template: DocumentTemplate }) {
  return (
    <>
      {template.draftWording ? <p className="text-sm text-ink-soft">{DRAFT_LINE}</p> : null}
      {template.kind === "health_declaration" ? <p className="text-sm text-ink-soft">{HEALTH_LINE}</p> : null}
    </>
  );
}

/**
 * SGN-01: the business's document templates: edit and delete (owners and admins with the plan key); without the key they
 * read them and may switch one off or delete it (owner (201) ב, `removable`); everyone else reads.
 */
export function DocumentTemplateList({
  orgId,
  templates,
  editable,
  removable = false,
  labels,
}: {
  orgId: string;
  templates: DocumentTemplate[];
  editable: boolean;
  removable?: boolean;
  labels: RecordTypeLabels;
}) {
  return (
    <ol className="divide-y divide-line">
      {templates.map((template) => (
        <li key={`${template.id}-${template.name}-${template.body}-${template.kind}-${template.recordType}-${template.isActive}`} className="px-4 py-3 sm:px-5">
          <details className="group">
            <summary className="cursor-pointer list-none">
              <RowHeading template={template} labels={labels} />
            </summary>
            <div className="mt-3 space-y-3">
              <Notes template={template} />
              {editable ? (
                <EditableBody orgId={orgId} template={template} labels={labels} />
              ) : (
                <>
                  <NoteText text={template.body} className="text-md text-ink" />
                  {removable ? <RemoveOnly orgId={orgId} template={template} /> : null}
                </>
              )}
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

function EditableBody({ orgId, template, labels }: { orgId: string; template: DocumentTemplate; labels: RecordTypeLabels }) {
  const [state, formAction] = useActionState<FormState, FormData>(updateDocumentTemplateAction.bind(null, orgId, template.id), null);
  const failure = state && !state.ok ? state : null;
  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-3" noValidate>
        <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
        <TemplateFields
          failure={failure}
          labels={labels}
          initial={{ name: template.name, kind: template.kind, recordType: template.recordType, body: template.body, isActive: template.isActive }}
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
        action={deleteDocumentTemplateAction.bind(null, orgId, template.id)}
        pendingText="מוחקים…"
        variant="danger-ghost"
        srLabel={template.name}
        confirm={`למחוק את התבנית "${template.name}"?`}
      >
        מחיקה
      </ActionButton>
    </div>
  );
}

/** Without the plan key: switch off (an active template) and delete, nothing else. */
function RemoveOnly({ orgId, template }: { orgId: string; template: DocumentTemplate }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {template.isActive ? (
        <ActionButton action={switchOffDocumentTemplateAction.bind(null, orgId, template.id)} pendingText="מכבים…" variant="secondary" srLabel={template.name}>
          כיבוי
        </ActionButton>
      ) : null}
      <ActionButton
        action={deleteDocumentTemplateAction.bind(null, orgId, template.id)}
        pendingText="מוחקים…"
        variant="danger-ghost"
        srLabel={template.name}
        confirm={`למחוק את התבנית "${template.name}"?`}
      >
        מחיקה
      </ActionButton>
    </div>
  );
}

export function AddDocumentTemplateForm({ orgId, labels }: { orgId: string; labels: RecordTypeLabels }) {
  const [state, formAction] = useActionState<FormState, FormData>(addDocumentTemplateAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate key={state?.ok ? "saved" : "editing"}>
      <h3 className="font-semibold">תבנית חדשה</h3>
      {state?.ok ? <FormNotice message="התבנית נוספה." /> : null}
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TemplateFields initial={EMPTY} failure={failure} labels={labels} />
      <SubmitButton size="sm" pendingText="מוסיפים…">
        הוספת תבנית
      </SubmitButton>
    </form>
  );
}

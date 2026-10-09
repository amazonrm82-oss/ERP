"use client";

import { useActionState, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createFieldAction, moveFieldAction, setFieldActiveAction, updateFieldAction } from "../actions";
import { FIELD_TYPE_LABELS, FIELD_TYPES, TYPES_WITH_OPTIONS, type FieldDefinition, type FieldObject, type FieldType } from "../types";

export function CreateFieldForm({ orgId, objectType }: { orgId: string; objectType: FieldObject }) {
  const [state, formAction] = useActionState<FormState, FormData>(createFieldAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [type, setType] = useState(values?.field_type ?? "text");

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="object_type" value={objectType} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="שם השדה"
          name="label"
          required
          maxLength={80}
          autoComplete="off"
          placeholder="למשל: תקציב משוער"
          defaultValue={values?.label}
          error={errors.label}
        />
        <SelectField label="סוג השדה" name="field_type" value={type} onChange={(event) => setType(event.target.value)} error={errors.field_type}>
          {FIELD_TYPES.map((option) => (
            <option key={option} value={option}>
              {FIELD_TYPE_LABELS[option]}
            </option>
          ))}
        </SelectField>
      </div>
      {TYPES_WITH_OPTIONS.includes(type as FieldType) ? (
        <TextareaField
          label="אפשרויות, כל אחת בשורה"
          name="options"
          rows={4}
          required
          defaultValue={values?.options}
          error={errors.options}
        />
      ) : null}
      <TextField label="הסבר קצר (לא חובה)" name="help_text" maxLength={200} autoComplete="off" defaultValue={values?.help_text} error={errors.help_text} />
      <label className="flex items-center gap-2.5 text-md">
        <input type="checkbox" name="is_required" defaultChecked={values?.is_required === "on"} className="size-4.5 accent-accent" />
        שדה חובה
      </label>
      <SubmitButton pendingText="מוסיפים…">הוספת שדה</SubmitButton>
    </form>
  );
}

type ListProps = { orgId: string; fields: FieldDefinition[]; editable: boolean };

export function FieldList({ orgId, fields, editable }: ListProps) {
  return (
    <ol className="divide-y divide-line">
      {fields.map((field, index) => (
        <FieldRow
          key={`${field.id}-${field.label}-${field.isActive}-${field.isRequired}-${field.options.join("|")}`}
          orgId={orgId}
          field={field}
          editable={editable}
          isFirst={index === 0}
          isLast={index === fields.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = { orgId: string; field: FieldDefinition; editable: boolean; isFirst: boolean; isLast: boolean };

function FieldRow({ orgId, field, editable, isFirst, isLast }: RowProps) {
  const [editing, setEditing] = useState(false);

  return (
    <li className="space-y-3 px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2">
          <span className={field.isActive ? "font-medium" : "font-medium text-ink-soft"}>{field.label}</span>
          <Badge>{FIELD_TYPE_LABELS[field.type]}</Badge>
          {field.isRequired ? <Badge tone="warning">חובה</Badge> : null}
          {field.isActive ? null : <Badge>מוסתר</Badge>}
        </p>
        {editable ? (
          <span className="flex flex-wrap items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing((value) => !value)} aria-expanded={editing}>
              עריכה
              <span className="sr-only">: {field.label}</span>
            </Button>
            <ActionButton action={moveFieldAction.bind(null, orgId, field.id, "up")} pendingText="מזיזים…" variant="ghost" srLabel={field.label} disabled={isFirst}>
              למעלה
            </ActionButton>
            <ActionButton action={moveFieldAction.bind(null, orgId, field.id, "down")} pendingText="מזיזים…" variant="ghost" srLabel={field.label} disabled={isLast}>
              למטה
            </ActionButton>
            <ActionButton action={setFieldActiveAction.bind(null, orgId, field.id, !field.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={field.label}>
              {field.isActive ? "הסתרה" : "הצגה"}
            </ActionButton>
          </span>
        ) : null}
      </div>
      {TYPES_WITH_OPTIONS.includes(field.type) && !editing ? <p className="text-sm text-ink-soft">אפשרויות: {field.options.join(", ")}</p> : null}
      {editing ? <EditFieldForm orgId={orgId} field={field} onDone={() => setEditing(false)} /> : null}
    </li>
  );
}

function EditFieldForm({ orgId, field, onDone }: { orgId: string; field: FieldDefinition; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateFieldAction(orgId, field.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-3 rounded-md border border-line p-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField label="שם השדה" name="label" required maxLength={80} autoComplete="off" defaultValue={values?.label ?? field.label} error={errors.label} />
      {TYPES_WITH_OPTIONS.includes(field.type) ? (
        <TextareaField
          label="אפשרויות, כל אחת בשורה"
          name="options"
          rows={4}
          hint="ערכים שכבר נשמרו ברשומות נשארים גם אם מוחקים אפשרות."
          defaultValue={values?.options ?? field.options.join("\n")}
          error={errors.options}
        />
      ) : null}
      <TextField label="הסבר קצר" name="help_text" maxLength={200} autoComplete="off" defaultValue={values?.help_text ?? field.helpText ?? ""} error={errors.help_text} />
      <label className="flex items-center gap-2.5 text-md">
        <input
          type="checkbox"
          name="is_required"
          defaultChecked={values ? values.is_required === "on" : field.isRequired}
          className="size-4.5 accent-accent"
        />
        שדה חובה
      </label>
      <div className="flex gap-2">
        <SubmitButton size="sm">שמירה</SubmitButton>
        <Button variant="ghost" size="sm" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";

import { ActionButton } from "@/components/action-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createFieldAction, moveFieldAction, setFieldActiveAction, updateFieldAction } from "../actions";
import { conditionReminder, describeCondition, type BuiltinChoices } from "../conditions";
import { canBeRequired, canBeUnique, canHaveDefault } from "../settings";
import { STATUS_COLORS, statusTone } from "../status-colors";
import { FIELD_OBJECT_LABELS, FIELD_TYPE_LABELS, FIELD_TYPES, LINK_TARGETS, TYPES_WITH_OPTIONS, type FieldDefinition, type FieldObject, type FieldType } from "../types";
import { displayCustomFields } from "../values";
import { ConditionEditor } from "./condition-editor";
import { CustomFieldInputs } from "./custom-field-inputs";

const UNIQUE_HINT = "שתי רשומות לא יכולות לקבל אותו ערך. סל המחזור ושדה מוסתר לא נבדקים. ליד מטופס באתר נשמר תמיד, ומסומן אם הערך כבר קיים.";
const READ_ONLY_HINT = "אפשר למלא פעם אחת, ואחר כך הערך נעול לכולם. כדי לשנות ערך, מבטלים זמנית את הסימון כאן.";

/** FLD-07: the "unique" and "read-only" boxes of the field forms. */
function SettingBoxes({ type, unique, onUnique, readOnly }: { type: FieldType; unique: boolean; onUnique: (value: boolean) => void; readOnly: boolean }) {
  return (
    <>
      {canBeUnique(type) ? (
        <label className="flex items-start gap-2.5 text-md">
          <input type="checkbox" name="is_unique" checked={unique} onChange={(event) => onUnique(event.target.checked)} className="mt-1 size-4.5 shrink-0 accent-accent" />
          <span>
            ערך ייחודי
            <span className="block text-sm text-ink-soft">{UNIQUE_HINT}</span>
          </span>
        </label>
      ) : null}
      <label className="flex items-start gap-2.5 text-md">
        <input type="checkbox" name="is_read_only" defaultChecked={readOnly} className="mt-1 size-4.5 shrink-0 accent-accent" />
        <span>
          קריאה בלבד אחרי מילוי
          <span className="block text-sm text-ink-soft">{READ_ONLY_HINT}</span>
        </span>
      </label>
    </>
  );
}

export function CreateFieldForm({ orgId, objectType }: { orgId: string; objectType: FieldObject }) {
  const [state, formAction] = useActionState<FormState, FormData>(createFieldAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const [type, setType] = useState(values?.field_type ?? "text");
  const [unique, setUnique] = useState(values?.is_unique === "on");

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
      {type === "record_link" ? (
        // FLD-06 part B: what the link points at; it cannot change after the field is added
        <SelectField
          label="מקשר אל"
          name="link_target"
          required
          defaultValue={values?.link_target ?? ""}
          hint="אי אפשר לשנות אחרי שמוסיפים את השדה."
          error={errors.link_target}
        >
          <option value="">בחירה</option>
          {LINK_TARGETS.map((target) => (
            <option key={target} value={target}>
              {FIELD_OBJECT_LABELS[target]}
            </option>
          ))}
        </SelectField>
      ) : null}
      {type === "file" ? <p className="text-sm text-ink-soft">קובץ אחד לשדה, עד 25 MB, נספר בנפח האחסון. מצרפים אותו בכרטיס אחרי שהרשומה נשמרה.</p> : null}
      <TextField label="הסבר קצר (לא חובה)" name="help_text" maxLength={200} autoComplete="off" defaultValue={values?.help_text} error={errors.help_text} />
      {canBeRequired(type as FieldType) ? (
        <label className="flex items-center gap-2.5 text-md">
          <input type="checkbox" name="is_required" defaultChecked={values?.is_required === "on"} className="size-4.5 accent-accent" />
          שדה חובה
        </label>
      ) : null}
      <SettingBoxes type={type as FieldType} unique={unique} onUnique={setUnique} readOnly={values?.is_read_only === "on"} />
      {errors.is_unique ? <p className="text-sm text-danger">{errors.is_unique}</p> : null}
      <p className="text-sm text-ink-soft">ערך ברירת מחדל, ומתי השדה מופיע או חובה, קובעים בכפתור &quot;עריכה&quot; של השדה, אחרי שמוסיפים אותו.</p>
      <SubmitButton pendingText="מוסיפים…">הוספת שדה</SubmitButton>
    </form>
  );
}

type ListProps = {
  orgId: string;
  objectType: FieldObject;
  fields: FieldDefinition[];
  // FLD-09: the choices of the built-in fields a condition may depend on
  builtins: BuiltinChoices;
  editable: boolean;
  // LEAD-06: the question before hiding a field that receives a lead field's value on conversion, by field id
  hideWarnings?: Record<string, string>;
};

export function FieldList({ orgId, objectType, fields, builtins, editable, hideWarnings = {} }: ListProps) {
  return (
    <ol className="divide-y divide-line">
      {fields.map((field, index) => (
        <FieldRow
          key={`${field.id}-${field.label}-${field.isActive}-${field.isRequired}-${field.isUnique}-${field.isReadOnly}-${JSON.stringify(field.defaultValue ?? null)}-${field.options.join("|")}-${JSON.stringify(field.condition ?? null)}`}
          orgId={orgId}
          objectType={objectType}
          fields={fields}
          builtins={builtins}
          field={field}
          editable={editable}
          hideWarning={hideWarnings[field.id]}
          isFirst={index === 0}
          isLast={index === fields.length - 1}
        />
      ))}
    </ol>
  );
}

type RowProps = {
  orgId: string;
  objectType: FieldObject;
  fields: FieldDefinition[];
  builtins: BuiltinChoices;
  field: FieldDefinition;
  editable: boolean;
  hideWarning?: string;
  isFirst: boolean;
  isLast: boolean;
};

function FieldRow({ orgId, objectType, fields, builtins, field, editable, hideWarning, isFirst, isLast }: RowProps) {
  const [editing, setEditing] = useState(false);
  const reminder = conditionReminder(field, fields, objectType, builtins);

  return (
    <li className="space-y-3 px-4 py-3.5 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2">
          <span className={field.isActive ? "font-medium" : "font-medium text-ink-soft"}>{field.label}</span>
          <Badge>{FIELD_TYPE_LABELS[field.type]}</Badge>
          {field.isRequired ? <Badge tone="warning">חובה</Badge> : null}
          {field.isUnique ? <Badge>ייחודי</Badge> : null}
          {field.isReadOnly ? <Badge>קריאה בלבד</Badge> : null}
          {field.condition ? <Badge>מותנה</Badge> : null}
          {!field.condition && field.conditionRemovedAt ? <Badge tone="warning">התנאי הוסר (תהליך המכירה נמחק)</Badge> : null}
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
            {field.isActive && hideWarning ? (
              <ConfirmButton
                variant="danger-ghost"
                title={`להסתיר את "${field.label}"?`}
                description={hideWarning}
                confirmLabel="הסתרה"
                action={setFieldActiveAction.bind(null, orgId, field.id, false)}
              >
                הסתרה
                <span className="sr-only">: {field.label}</span>
              </ConfirmButton>
            ) : (
              <ActionButton action={setFieldActiveAction.bind(null, orgId, field.id, !field.isActive)} pendingText="מעדכנים…" variant="ghost" srLabel={field.label}>
                {field.isActive ? "הסתרה" : "הצגה"}
              </ActionButton>
            )}
          </span>
        ) : null}
      </div>
      {field.type === "status" && !editing ? (
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink-soft">
          אפשרויות:
          {field.options.map((option) => (
            <Badge key={option} tone={statusTone(field, option)}>
              {option}
            </Badge>
          ))}
        </p>
      ) : TYPES_WITH_OPTIONS.includes(field.type) && !editing ? (
        <p className="text-sm text-ink-soft">אפשרויות: {field.options.join(", ")}</p>
      ) : null}
      {hasDefault(field) && !editing ? (
        <p className="text-sm text-ink-soft">
          ברירת מחדל: <span dir="auto">{displayCustomFields([field], { [field.key]: field.defaultValue ?? null })[0].text}</span>
        </p>
      ) : null}
      {field.condition && !editing ? <p className="text-sm text-ink-soft">{describeCondition(field.condition, fields, objectType, builtins)}</p> : null}
      {reminder ? <p className="text-sm text-warning">{reminder}</p> : null}
      {editing ? <EditFieldForm orgId={orgId} objectType={objectType} fields={fields} builtins={builtins} field={field} onDone={() => setEditing(false)} /> : null}
    </li>
  );
}

function hasDefault(field: FieldDefinition): boolean {
  return field.defaultValue !== null && field.defaultValue !== undefined;
}

type EditProps = { orgId: string; objectType: FieldObject; fields: FieldDefinition[]; builtins: BuiltinChoices; field: FieldDefinition; onDone: () => void };

function EditFieldForm({ orgId, objectType, fields, builtins, field, onDone }: EditProps) {
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
  const [unique, setUnique] = useState(values ? values.is_unique === "on" : field.isUnique === true);
  // the default is typed in the field's own input (a unique field has none)
  const defaultInput: FieldDefinition = {
    ...field,
    label: "ערך ברירת מחדל (לא חובה)",
    isRequired: false,
    isReadOnly: false,
    condition: null,
    helpText: "ממולא מראש ברשומה חדשה. מי שיוצר את הרשומה יכול לשנות אותו.",
  };

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
      {field.type === "status" ? <StatusColorPickers field={field} /> : null}
      <TextField label="הסבר קצר" name="help_text" maxLength={200} autoComplete="off" defaultValue={values?.help_text ?? field.helpText ?? ""} error={errors.help_text} />
      {field.type === "record_link" && field.linkTarget ? (
        <p className="text-sm text-ink-soft">מקשר אל: {FIELD_OBJECT_LABELS[field.linkTarget]}</p>
      ) : null}
      {canBeRequired(field.type) ? (
        <label className="flex items-center gap-2.5 text-md">
          <input
            type="checkbox"
            name="is_required"
            defaultChecked={values ? values.is_required === "on" : field.isRequired}
            className="size-4.5 accent-accent"
          />
          שדה חובה
        </label>
      ) : null}
      <SettingBoxes type={field.type} unique={unique} onUnique={setUnique} readOnly={values ? values.is_read_only === "on" : field.isReadOnly === true} />
      {canHaveDefault(field.type) && !unique ? (
        <CustomFieldInputs definitions={[defaultInput]} stored={{ [field.key]: field.defaultValue ?? null }} submitted={values} errors={errors} />
      ) : null}
      <ConditionEditor field={field} definitions={fields} objectType={objectType} builtins={builtins} submitted={values} error={errors.condition} />
      <div className="flex gap-2">
        <SubmitButton size="sm">שמירה</SubmitButton>
        <Button variant="ghost" size="sm" onClick={onDone}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/**
 * FLD-06: a colour for each saved option of a status field, from the design system's palette. An option added in
 * the box above gets its colour after saving (it starts grey); a renamed option starts grey again.
 */
function StatusColorPickers({ field }: { field: FieldDefinition }) {
  if (field.options.length === 0) return null;
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium">צבע לכל אפשרות</legend>
      <ul className="space-y-2">
        {field.options.map((option) => (
          <li key={option} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="color_option" value={option} />
            <Badge tone={statusTone(field, option)}>{option}</Badge>
            <SelectField label={`הצבע של "${option}"`} hideLabel name="color_value" defaultValue={statusTone(field, option)} controlSize="sm" className="w-32">
              {STATUS_COLORS.map((color) => (
                <option key={color.value} value={color.value}>
                  {color.label}
                </option>
              ))}
            </SelectField>
          </li>
        ))}
      </ul>
      <p className="text-sm text-ink-soft">אפשרות חדשה מקבלת צבע אחרי השמירה. עד אז היא באפור.</p>
    </fieldset>
  );
}

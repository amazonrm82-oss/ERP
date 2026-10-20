"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { initialChoice, pickerLabelName } from "@/components/ui/search-picker-logic";
import { ContactPicker } from "@/features/contacts/components/contact-picker";
import { NoteEditor } from "@/features/activities/components/note-editor";

import { conditionApplies, fieldState, hasConditions, shownMarkerName, type ConditionValues } from "../conditions";
import { readConditionValues } from "../live-conditions";
import { inputName, type CustomValues, type FieldDefinition, type FieldObject } from "../types";
import { isEmptyCustomValue } from "../settings";
import { displayCustomFields, inputValue } from "../values";

type Props = {
  definitions: FieldDefinition[];
  // stored values of the record (edit forms); absent on a create form, which shows the fields' default values
  stored?: CustomValues;
  // what the user typed, after a failed submit (keyed by input name)
  submitted?: Record<string, string>;
  errors?: Record<string, string>;
  // FLD-09: the record type (for built-in controlling fields) and the record's built-in values
  // ("builtin:status" → id) that the form may not have an input for
  objectType?: FieldObject;
  builtins?: Record<string, string | null>;
};

/** A read-only field (FLD-07) that holds a value, in an edit form: the value as text, never an input. */
function ReadOnlyValue({ field, values }: { field: FieldDefinition; values: CustomValues }) {
  const [shown] = displayCustomFields([field], values);
  return (
    <div>
      <p className="mb-1.5 text-sm font-medium">{field.label}</p>
      <p className="text-md" dir={shown.ltr && shown.text ? "ltr" : undefined}>
        {shown.text}
      </p>
      <p className="text-sm text-ink-soft">שדה לקריאה בלבד</p>
    </div>
  );
}

/** Inputs for a record's active custom fields. Renders nothing when there are none. */
export function CustomFieldInputs({ definitions, stored, submitted, errors = {}, objectType, builtins }: Props) {
  const editing = stored !== undefined;
  // FLD-07: a create form starts with the fields' default values
  const initial: CustomValues = editing
    ? stored
    : Object.fromEntries(definitions.filter((field) => field.defaultValue !== null && field.defaultValue !== undefined).map((field) => [field.key, field.defaultValue]));
  const watching = hasConditions(definitions, objectType);
  const ref = useRef<HTMLFieldSetElement>(null);
  // FLD-09: the values the conditions read, from the form as it is now (null before the first read)
  const [live, setLive] = useState<ConditionValues | null>(null);
  // said politely to screen readers when a field shows or hides
  const [announcement, setAnnouncement] = useState("");
  const shownBefore = useRef<Map<string, boolean> | null>(null);
  const latest = useRef({ definitions, objectType, builtins, initial });
  useEffect(() => {
    latest.current = { definitions, objectType, builtins, initial };
  });
  // read again when the record's values or the fields change (a status changed on the page, a refresh)
  const inputsKey = JSON.stringify([builtins ?? null, stored ?? null, definitions.map((field) => [field.key, field.isActive, field.condition ?? null])]);
  useEffect(() => {
    const form = ref.current?.form;
    if (!watching || !form) return;
    const read = () => {
      const now = latest.current;
      const values = readConditionValues(form, now.definitions, now.objectType, now.builtins ?? {}, now.initial);
      const shown = new Map(
        now.definitions
          .filter((field) => field.condition && conditionApplies(field.condition, now.definitions, now.objectType))
          .map((field) => [field.key, fieldState(field, now.definitions, values, now.objectType).visible]),
      );
      const before = shownBefore.current;
      if (before) {
        const changes = now.definitions
          .filter((field) => shown.has(field.key) && before.has(field.key) && shown.get(field.key) !== before.get(field.key))
          .map((field) => (shown.get(field.key) ? `השדה ${field.label} מוצג.` : `השדה ${field.label} הוסתר.`));
        if (changes.length > 0) setAnnouncement(changes.join(" "));
      }
      shownBefore.current = shown;
      setLive(values);
    };
    read();
    form.addEventListener("input", read);
    form.addEventListener("change", read);
    return () => {
      form.removeEventListener("input", read);
      form.removeEventListener("change", read);
    };
  }, [watching, inputsKey]);

  if (definitions.length === 0) {
    return null;
  }
  const conditionValues: ConditionValues = live ?? { ...initial, ...(builtins ?? {}) };
  return (
    <fieldset ref={ref} className="space-y-4 border-t border-line pt-4">
      <legend className="sr-only">שדות נוספים</legend>
      {watching ? (
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      ) : null}
      {definitions.map((field) => {
        const state = watching ? fieldState(field, definitions, conditionValues, objectType) : { visible: true, required: field.isRequired };
        // FLD-07: open while empty (it may be filled once), locked once it holds a value
        if (editing && field.isReadOnly && !isEmptyCustomValue(stored[field.key])) {
          return state.visible ? <ReadOnlyValue key={field.id} field={field} values={stored} /> : null;
        }
        const conditional = watching && field.condition ? conditionApplies(field.condition, definitions, objectType) : false;
        const input = fieldInput(field, state.required, submitted, initial, errors, conditional);
        if (!conditional) return input;
        // a hidden field is not sent, nor its marker: an edit keeps its stored value (the server skips it)
        return (
          <fieldset key={field.id} hidden={!state.visible} disabled={!state.visible} className="min-w-0">
            <input type="hidden" name={shownMarkerName(field.key)} value="1" />
            {input}
          </fieldset>
        );
      })}
    </fieldset>
  );
}

function fieldInput(
  field: FieldDefinition,
  required: boolean,
  submitted: Record<string, string> | undefined,
  initial: CustomValues,
  errors: Record<string, string>,
  conditional: boolean,
): ReactNode {
  const name = inputName(field.key);
  // a conditional field that was hidden when the form was sent was not posted: start from the record again
  const wasHidden = conditional && submitted !== undefined && !(shownMarkerName(field.key) in submitted);
  const value = submitted && !wasHidden ? (submitted[name] ?? "") : inputValue(field, initial);
  const common = {
    label: field.label,
    name,
    required,
    hint: field.isReadOnly ? [field.helpText, "שדה לקריאה בלבד: אחרי שממלאים אותו אי אפשר לשנות."].filter(Boolean).join(" ") : (field.helpText ?? undefined),
    error: errors[name],
  };
  switch (field.type) {
    case "long_text":
      return <TextareaField key={field.id} {...common} maxLength={5000} defaultValue={value} />;
    case "rich_text":
      // FLD-06: REC-04's editor (bold, lists, links), stored as cleaned Markdown
      return (
        <div key={field.id}>
          <NoteEditor label={required ? `${field.label} (חובה)` : field.label} name={name} rows={4} maxLength={5000} defaultValue={value} error={errors[name]} />
          {common.hint ? <p className="mt-1 text-sm text-ink-soft">{common.hint}</p> : null}
        </div>
      );
    case "duration":
      return (
        <TextField
          key={field.id}
          {...common}
          hint={common.hint ?? "בדקות (90) או בשעות ודקות (1:30)"}
          dir="ltr"
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          defaultValue={value}
        />
      );
    case "status":
    case "select":
      return (
        <SelectField key={`${field.id}-${value}`} {...common} defaultValue={value}>
          <option value="">לא נבחר</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </SelectField>
      );
    case "checkbox":
      return (
        <div key={`${field.id}-${value}`}>
          <label className="flex min-h-11 items-center gap-2.5 text-md">
            <input type="checkbox" name={name} defaultChecked={value === "on"} className="size-4.5 accent-accent" />
            {field.label}
            {required ? (
              <span aria-hidden="true" className="text-danger">
                *
              </span>
            ) : null}
          </label>
          {errors[name] ? <p className="text-sm text-danger">{errors[name]}</p> : null}
          {field.helpText ? <p className="text-sm text-ink-soft">{field.helpText}</p> : null}
        </div>
      );
    case "multi_select": {
      const picked = value.split("\n");
      return (
        <fieldset key={`${field.id}-${value}`} aria-describedby={errors[name] ? `${name}-error` : undefined}>
          <legend className="mb-1.5 text-sm font-medium">
            {field.label}
            {required ? (
              <span aria-hidden="true" className="ms-0.5 text-danger">
                *
              </span>
            ) : null}
          </legend>
          <div className="flex flex-wrap gap-x-4">
            {field.options.map((option) => (
              <label key={option} className="flex min-h-11 items-center gap-2 text-md">
                <input type="checkbox" name={name} value={option} defaultChecked={picked.includes(option)} className="size-4.5 accent-accent" />
                {option}
              </label>
            ))}
          </div>
          {errors[name] ? (
            <p id={`${name}-error`} className="text-sm text-danger">
              {errors[name]}
            </p>
          ) : null}
          {field.helpText ? <p className="text-sm text-ink-soft">{field.helpText}</p> : null}
        </fieldset>
      );
    }
    case "rating":
      return (
        <SelectField key={`${field.id}-${value}`} {...common} defaultValue={value}>
          <option value="">לא נבחר</option>
          {[1, 2, 3, 4, 5].map((n) => (
            <option key={n} value={String(n)}>
              {n} מתוך 5
            </option>
          ))}
        </SelectField>
      );
    case "user":
      // DEAL-05: the deal's contact is searched, not listed (the server accepts any contact the person reads)
      if (field.contactPicker) {
        return (
          <ContactPicker
            key={`${field.id}-${value}`}
            orgId={field.contactPicker.orgId}
            name={name}
            label={field.label}
            required={required}
            initial={initialChoice(value, submitted?.[pickerLabelName(name)], "איש קשר")}
            error={errors[name]}
            hint={field.helpText ?? undefined}
          />
        );
      }
      return (
        <SelectField key={`${field.id}-${value}`} {...common} defaultValue={value}>
          <option value="">לא נבחר</option>
          {(field.choices ?? []).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </SelectField>
      );
    case "currency":
      return <TextField key={field.id} {...common} hint={field.helpText ?? "בשקלים"} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
    case "percent":
      return <TextField key={field.id} {...common} hint={field.helpText ?? "באחוזים"} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
    case "datetime":
      return <TextField key={field.id} {...common} type="datetime-local" defaultValue={value} />;
    case "il_id":
    case "il_company_id":
      return <TextField key={field.id} {...common} dir="ltr" inputMode="numeric" maxLength={11} autoComplete="off" defaultValue={value} />;
    case "date":
      return <TextField key={field.id} {...common} type="date" defaultValue={value} />;
    case "number":
      return <TextField key={field.id} {...common} dir="ltr" inputMode="decimal" autoComplete="off" defaultValue={value} />;
    case "phone":
      return <TextField key={field.id} {...common} type="tel" dir="ltr" inputMode="tel" autoComplete="off" defaultValue={value} />;
    case "email":
      return <TextField key={field.id} {...common} type="email" dir="ltr" inputMode="email" autoComplete="off" defaultValue={value} />;
    case "url":
      return <TextField key={field.id} {...common} dir="ltr" inputMode="url" autoComplete="off" defaultValue={value} />;
    case "text":
      return <TextField key={field.id} {...common} maxLength={500} autoComplete="off" defaultValue={value} />;
    default: {
      // every type has its own input: a new type fails the build here until it gets one
      const unhandled: never = field.type;
      return unhandled;
    }
  }
}

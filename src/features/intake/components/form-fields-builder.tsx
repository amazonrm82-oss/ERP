"use client";

import { useId, useState } from "react";

import { Button, IconButton } from "@/components/ui/button";
import { Checkbox, Label, Select, SelectField, TextField } from "@/components/ui/field";
import { PlusIcon, TrashIcon } from "@/components/ui/icons";
import { ReorderButtons } from "@/components/ui/reorder-buttons";
import { FIELD_TYPE_LABELS } from "@/features/custom-fields/types";

import { MAX_FORM_FIELDS, MAX_HELP_LENGTH, type FormFieldConfig, type FormFieldOption } from "../fields";

type Props = { initial: FormFieldConfig[]; options: FormFieldOption[] };

const ALWAYS = "";

/** A condition as one select value. */
function conditionValue(field: FormFieldConfig): string {
  return field.showIf ? JSON.stringify([field.showIf.field, field.showIf.value]) : ALWAYS;
}

/** Conditions may only point at a field above; anything else falls back to "always". */
function keepConditionsValid(fields: FormFieldConfig[]): FormFieldConfig[] {
  return fields.map((field, i) => {
    if (field.showIf && !fields.slice(0, i).some((before) => before.key === field.showIf?.field)) {
      return { ...field, showIf: null };
    }
    return field;
  });
}

/**
 * The form builder (CAP-01): which fields the form asks for, in what order,
 * required or not, with help text and an optional "show only when". The list
 * travels to the Server Action as JSON in the hidden input fields_json.
 */
export function FormFieldsBuilder({ initial, options }: Props) {
  const [fields, setFields] = useState<FormFieldConfig[]>(() => keepConditionsValid(initial.filter((f) => options.some((o) => o.key === f.key))));
  const [adding, setAdding] = useState("");
  const addId = useId();
  const optionOf = (key: string) => options.find((option) => option.key === key);
  const labelOf = (key: string) => optionOf(key)?.label ?? key;
  const unused = options.filter((option) => option.isActive && !fields.some((field) => field.key === option.key));

  const change = (index: number, patch: Partial<FormFieldConfig>) =>
    setFields((all) => keepConditionsValid(all.map((field, i) => (i === index ? { ...field, ...patch } : field))));
  const move = (index: number, direction: -1 | 1) =>
    setFields((all) => {
      const next = [...all];
      const [item] = next.splice(index, 1);
      next.splice(index + direction, 0, item);
      return keepConditionsValid(next);
    });
  const remove = (index: number) => setFields((all) => keepConditionsValid(all.filter((_, i) => i !== index)));
  const add = () => {
    if (!adding) return;
    setFields((all) => [...all, { key: adding, required: false, help: null, showIf: null }]);
    setAdding("");
  };

  return (
    <fieldset className="rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-medium">שדות בטופס</legend>
      <input type="hidden" name="fields_json" value={JSON.stringify(fields)} />
      <p className="text-sm text-ink-soft">
        הסדר כאן הוא הסדר בטופס. שדות מותאמים של לידים נשמרים בליד. שדה עם תנאי מופיע רק כשהתנאי מתקיים, ורק אז הוא חובה.
      </p>
      {fields.length === 0 ? <p className="py-3 text-md text-ink-soft">אין עדיין שדות בטופס.</p> : null}
      <ol className="mt-2 divide-y divide-line">
        {fields.map((field, index) => {
          const option = optionOf(field.key);
          const label = labelOf(field.key);
          const earlier = fields.slice(0, index);
          return (
            <li key={field.key} className="space-y-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-medium break-words">{label}</span>
                  <span className="block text-sm text-ink-soft">
                    {option?.type ? `שדה מותאם · ${FIELD_TYPE_LABELS[option.type]}` : "שדה קבוע"}
                    {option && !option.isActive ? " · כבוי, לא יוצג בטופס" : ""}
                  </span>
                </span>
                <span className="flex items-center">
                  <ReorderButtons name={label} first={index === 0} last={index === fields.length - 1} onMove={(direction) => move(index, direction)} />
                  <IconButton label={`להסיר מהטופס: ${label}`} icon={<TrashIcon className="size-4.5" />} onClick={() => remove(index)} />
                </span>
              </div>
              <Checkbox label={`חובה: ${label}`} checked={field.required} onChange={(event) => change(index, { required: event.currentTarget.checked })} />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField
                  label={`טקסט עזרה: ${label}`}
                  hint="לא חובה. מופיע מתחת לשדה."
                  maxLength={MAX_HELP_LENGTH}
                  autoComplete="off"
                  value={field.help ?? ""}
                  onChange={(event) => change(index, { help: event.currentTarget.value })}
                />
                <SelectField
                  label={`מתי להציג: ${label}`}
                  value={conditionValue(field)}
                  disabled={earlier.length === 0}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    if (value === ALWAYS) {
                      change(index, { showIf: null });
                      return;
                    }
                    const [on, equals] = JSON.parse(value) as [string, string | null];
                    change(index, { showIf: { field: on, value: equals } });
                  }}
                >
                  <option value={ALWAYS}>תמיד</option>
                  {earlier.map((before) => {
                    const beforeOption = optionOf(before.key);
                    const beforeLabel = labelOf(before.key);
                    const choices = beforeOption?.type === "select" || beforeOption?.type === "multi_select" ? beforeOption.options : [];
                    return [
                      <option key={`${before.key}-any`} value={JSON.stringify([before.key, null])}>
                        {beforeOption?.type === "checkbox" ? `כש"${beforeLabel}" מסומן` : `כש"${beforeLabel}" מולא`}
                      </option>,
                      ...choices.map((choice) => (
                        <option key={`${before.key}-${choice}`} value={JSON.stringify([before.key, choice])}>
                          {`כש"${beforeLabel}" הוא ${choice}`}
                        </option>
                      )),
                    ];
                  })}
                </SelectField>
              </div>
            </li>
          );
        })}
      </ol>
      {unused.length > 0 && fields.length < MAX_FORM_FIELDS ? (
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <div className="min-w-0 flex-1 basis-48">
            <Label htmlFor={addId}>הוספת שדה</Label>
            <Select id={addId} value={adding} onChange={(event) => setAdding(event.currentTarget.value)}>
              <option value="">בחירת שדה…</option>
              {unused.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.type ? `${option.label} (${FIELD_TYPE_LABELS[option.type]})` : option.label}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="secondary" onClick={add} disabled={!adding}>
            <PlusIcon className="size-4.5" />
            הוספה
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}

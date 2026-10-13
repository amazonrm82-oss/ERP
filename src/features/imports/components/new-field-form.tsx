"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { createImportFieldAction } from "@/features/custom-fields/actions";
import { FIELD_TYPE_LABELS, TYPES_WITH_OPTIONS, type FieldType } from "@/features/custom-fields/types";
import { formatNumber } from "@/lib/format";

import type { ImportEntityKey } from "../fields";
import { columnOptions, IMPORT_NEW_FIELD_TYPES, MAX_COLUMN_OPTIONS, suggestFieldType } from "../new-field";

type Props = {
  orgId: string;
  entity: ImportEntityKey;
  entityLabel: string;
  header: string;
  // the filled cells of the column
  values: string[];
  onCreated: (field: { key: string; label: string }) => void;
  onCancel: () => void;
};

/** IMP-01: makes a custom field from one column of the file and maps the column to it. */
export function NewFieldForm({ orgId, entity, entityLabel, header, values, onCreated, onCancel }: Props) {
  const [label, setLabel] = useState(header.slice(0, 80));
  const [type, setType] = useState<FieldType>(() => suggestFieldType(values));
  // the choices of a list field are filled from the column; after that they are the user's text
  const [options, setOptions] = useState(() => columnOptions(values, "select").options.join("\n"));
  const [more, setMore] = useState(() => columnOptions(values, "select").more);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hasOptions = TYPES_WITH_OPTIONS.includes(type);

  function changeType(next: FieldType) {
    // switching between one choice and several reads the column again (commas split the values only for several)
    if (TYPES_WITH_OPTIONS.includes(next) && next !== type) {
      const made = columnOptions(values, next);
      setOptions(made.options.join("\n"));
      setMore(made.more);
    }
    setType(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    const result = await createImportFieldAction(orgId, { objectType: entity, label, fieldType: type, options: hasOptions ? options : "" }).catch(() => null);
    setBusy(false);
    if (!result || !result.ok || !result.data) {
      setError(result && !result.ok ? result.message : "לא הצלחנו להוסיף את השדה. נסו שוב.");
      return;
    }
    onCreated(result.data);
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3 rounded-md border border-line bg-canvas p-3 sm:col-span-3 sm:p-4" aria-label={`שדה חדש לעמודה ${header}`}>
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="שם השדה" value={label} onChange={(e) => setLabel(e.target.value)} required maxLength={80} autoComplete="off" autoFocus />
        <SelectField label="סוג השדה" value={type} onChange={(e) => changeType(e.target.value as FieldType)}>
          {IMPORT_NEW_FIELD_TYPES.map((option) => (
            <option key={option} value={option}>
              {FIELD_TYPE_LABELS[option]}
            </option>
          ))}
        </SelectField>
      </div>
      {hasOptions ? (
        <TextareaField
          label="אפשרויות, כל אחת בשורה"
          rows={5}
          required
          value={options}
          onChange={(e) => setOptions(e.target.value)}
          hint={
            more
              ? `מולאו ${formatNumber(MAX_COLUMN_OPTIONS)} הערכים השונים הראשונים בעמודה. שורה עם ערך שלא ברשימה תיכשל, ואפשר להוסיף אותו כאן.`
              : "מולאו הערכים השונים שבעמודה. שורה עם ערך שלא ברשימה תיכשל."
          }
        />
      ) : null}
      <p className="text-sm text-ink-soft">
        השדה יתווסף לכל ה{entityLabel} ויופיע בטפסים ובכרטיסים. הוא נשאר גם אם תבטלו את הייבוא.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={busy}>
          {busy ? "מוסיפים…" : "הוספה ומיפוי העמודה"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

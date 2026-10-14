"use client";

import { useState } from "react";

import { SelectField } from "@/components/ui/field";

import {
  BUILTIN_CONDITION_FIELDS,
  controllerCandidates,
  controllerChoices,
  isBuiltinKey,
  isController,
  OP_LABELS,
  opsForType,
  valueToChoices,
  type BuiltinChoices,
  type ConditionOp,
} from "../conditions";
import type { FieldDefinition, FieldObject } from "../types";

const SHOW_HINT = "כשהתנאי לא מתקיים השדה מוסתר בטופס ובכרטיס. ערך שכבר נשמר בו נשאר ולא נמחק.";
const REQUIRE_HINT = "החובה נבדקת רק בטפסים של הרשומה. טופס באתר, ייבוא והמרת ליד לא נחסמים.";

type Props = {
  field: FieldDefinition;
  // every field of the record type, hidden ones included
  definitions: FieldDefinition[];
  objectType: FieldObject;
  builtins: BuiltinChoices;
  // what the user sent, after a failed save (keyed by input name)
  submitted?: Record<string, string>;
  error?: string;
};

/** FLD-09: "when does the field show / when is it required", inside the field's edit form. */
export function ConditionEditor({ field, definitions, objectType, builtins, submitted, error }: Props) {
  const stored = field.condition ?? null;
  const [effect, setEffect] = useState(submitted?.condition_effect ?? stored?.effect ?? "none");
  const [controller, setController] = useState(submitted?.condition_field ?? stored?.field ?? "");
  const [op, setOp] = useState<string>(submitted?.condition_op ?? stored?.op ?? "");
  const [picked, setPicked] = useState<string[]>(submitted?.condition_value ? submitted.condition_value.split("\n") : valueToChoices(stored));

  if (isController(field, definitions)) {
    return <p className="text-sm text-ink-soft">שדה אחר תלוי בשדה הזה, ולכן אין לו תנאי משלו.</p>;
  }

  const builtinFields = BUILTIN_CONDITION_FIELDS[objectType];
  const candidates = controllerCandidates(field, definitions);
  // a saved controller that is no longer offered (hidden, deleted) stays visible so the choice is not lost silently
  const storedMissing = stored && controller === stored.field && !isBuiltinKey(controller) && !candidates.some((c) => c.key === controller);
  const controllerType = isBuiltinKey(controller) ? "builtin" : (candidates.find((c) => c.key === controller)?.type ?? null);
  const ops: ConditionOp[] = controllerType ? opsForType(controllerType) : [];
  const currentOp = ops.includes(op as ConditionOp) ? (op as ConditionOp) : (ops[0] ?? "");
  // a saved value that was removed from the list stays offered, marked, so saving other settings keeps it
  const removed = stored && controller === stored.field ? valueToChoices(stored) : [];
  const listed = controllerChoices(controller, definitions, builtins);
  const choices = [...listed, ...removed.filter((value) => !listed.some((c) => c.value === value)).map((value) => ({ value, label: "ערך שהוסר" }))];
  const takesValue = currentOp === "equals" || currentOp === "not_equals" || currentOp === "in";
  const errorId = `condition-error-${field.id}`;

  return (
    <fieldset className="space-y-3 rounded-md border border-line p-3" aria-describedby={error ? errorId : undefined}>
      <legend className="px-1 text-sm font-medium">מתי השדה מופיע או חובה</legend>
      <SelectField label="תנאי" name="condition_effect" value={effect} onChange={(event) => setEffect(event.target.value)}>
        <option value="none">תמיד, בלי תנאי</option>
        <option value="show">מתי השדה מופיע: רק כאשר…</option>
        <option value="require">מתי השדה חובה: כאשר…</option>
      </SelectField>
      {effect === "none" ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField
              label="לפי השדה"
              name="condition_field"
              value={controller}
              onChange={(event) => {
                setController(event.target.value);
                setPicked([]);
              }}
            >
              <option value="">יש לבחור שדה</option>
              {builtinFields.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
              {candidates.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
              {storedMissing ? <option value={controller}>שדה שהוסתר או נמחק</option> : null}
            </SelectField>
            {storedMissing && stored ? (
              <>
                <input type="hidden" name="condition_op" value={stored.op} />
                {valueToChoices(stored).map((value) => (
                  <input key={value} type="hidden" name="condition_value" value={value} />
                ))}
              </>
            ) : null}
            {ops.length > 0 ? (
              <SelectField label="התנאי" name="condition_op" value={currentOp} onChange={(event) => setOp(event.target.value)}>
                {ops.map((item) => (
                  <option key={item} value={item}>
                    {OP_LABELS[item]}
                  </option>
                ))}
              </SelectField>
            ) : null}
          </div>
          {takesValue && currentOp === "in" ? (
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">ערכים</legend>
              <div className="flex flex-wrap gap-x-4">
                {choices.map((choice) => (
                  <label key={choice.value} className="flex min-h-11 items-center gap-2 text-md">
                    <input
                      type="checkbox"
                      name="condition_value"
                      value={choice.value}
                      checked={picked.includes(choice.value)}
                      onChange={(event) =>
                        setPicked((current) => (event.target.checked ? [...current, choice.value] : current.filter((value) => value !== choice.value)))
                      }
                      className="size-4.5 accent-accent"
                    />
                    {choice.label}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : takesValue ? (
            <SelectField label="ערך" name="condition_value" value={picked[0] ?? ""} onChange={(event) => setPicked(event.target.value ? [event.target.value] : [])}>
              <option value="">יש לבחור ערך</option>
              {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </SelectField>
          ) : null}
          {storedMissing ? <p className="text-sm text-warning">השדה שהתנאי תלוי בו מוסתר או נמחק, ולכן התנאי לא פועל. בחרו שדה אחר או &quot;תמיד, בלי תנאי&quot;.</p> : null}
          <p className="text-sm text-ink-soft">{effect === "show" ? SHOW_HINT : REQUIRE_HINT}</p>
        </>
      )}
      {error ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

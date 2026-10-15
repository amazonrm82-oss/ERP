"use client";

import { useActionState, useState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addScoreRuleAction } from "../actions";
import { opLabel, SCORE_ACTIVITY_MAX, SCORE_POINTS_MAX, valueKindOf, type ScoreFieldChoice, type ScoreOp } from "../rules";

const GROUPS: Array<{ group: ScoreFieldChoice["group"]; label: string }> = [
  { group: "lead", label: "פרטי הליד" },
  { group: "custom", label: "שדות שלכם" },
  { group: "activity", label: "פעילות בציר הזמן" },
];

/** LEAD-05: a new rule: what it looks at, the condition, and how many points it adds or takes off. */
export function AddRuleForm({ orgId, choices }: { orgId: string; choices: ScoreFieldChoice[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(addScoreRuleAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const [fieldKey, setFieldKey] = useState(failure?.values?.field ?? choices[0]?.key ?? "");
  const choice = choices.find((c) => c.key === fieldKey) ?? choices[0];
  const [opPicked, setOpPicked] = useState<string>(failure?.values?.op ?? "");
  const op: ScoreOp | undefined = choice?.ops.includes(opPicked as ScoreOp) ? (opPicked as ScoreOp) : choice?.ops[0];
  if (!choice || !op) {
    return null;
  }
  const kind = valueKindOf(choice, op);
  // a typed value is kept only while the field stays the same
  const keptValue = failure?.values?.field === choice.key ? failure.values.value : undefined;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SelectField label="על מה הכלל" name="field" value={choice.key} onChange={(e) => setFieldKey(e.target.value)} error={errors.field}>
          {GROUPS.map(({ group, label }) => {
            const inGroup = choices.filter((c) => c.group === group);
            return inGroup.length > 0 ? (
              <optgroup key={group} label={label}>
                {inGroup.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </SelectField>
        <SelectField label="תנאי" name="op" value={op} onChange={(e) => setOpPicked(e.target.value)} error={errors.op}>
          {choice.ops.map((o) => (
            <option key={o} value={o}>
              {opLabel(choice, o)}
            </option>
          ))}
        </SelectField>
        {kind === "none" ? (
          <input type="hidden" name="value" value="" />
        ) : kind === "option" ? (
          <SelectField key={`${choice.key}-option`} label="ערך" name="value" defaultValue={keptValue} error={errors.value}>
            {(choice.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </SelectField>
        ) : (
          <TextField
            key={`${choice.key}-${kind}`}
            label={kind === "money" ? "סכום (₪)" : kind === "count" ? "כמה פעמים" : "מספר"}
            name="value"
            inputMode={kind === "money" || kind === "number" ? "decimal" : "numeric"}
            dir="ltr"
            autoComplete="off"
            required
            defaultValue={keptValue ?? (kind === "count" ? "1" : "")}
            hint={kind === "count" ? `עד ${SCORE_ACTIVITY_MAX}. הערות פרטיות לא נספרות.` : undefined}
            error={errors.value}
          />
        )}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:max-w-md">
        <SelectField label="נקודות" name="direction" defaultValue={failure?.values?.direction ?? "add"} error={errors.direction}>
          <option value="add">מוסיף</option>
          <option value="subtract">מוריד</option>
        </SelectField>
        <TextField
          label="כמה נקודות"
          name="points"
          inputMode="numeric"
          dir="ltr"
          autoComplete="off"
          required
          defaultValue={failure?.values?.points ?? "10"}
          hint={`1 עד ${SCORE_POINTS_MAX}`}
          error={errors.points}
        />
      </div>
      <FormError message={failure && Object.keys(errors).length === 0 ? failure.message : null} />
      <SubmitButton pendingText="מוסיפים…">הוספת כלל</SubmitButton>
    </form>
  );
}

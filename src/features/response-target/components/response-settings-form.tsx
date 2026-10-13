"use client";

import { useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveResponseSettingsAction } from "../actions";
import { BREACH_ACTION_OPTIONS, PASSES_MAX, PASSES_MIN, TARGET_MAX, TARGET_MIN, type ResponseSettings } from "../settings";

// canPassOn: the plan holds auto_reassign (SPD-03); without it the option shows, switched off, with a note
type Props = { orgId: string; settings: ResponseSettings; clockNote: string; canPassOn: boolean };

/** The response target of a new lead and what happens when it is missed (CAP-10). Owners and admins. */
export function ResponseSettingsForm({ orgId, settings, clockNote, canPassOn }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveResponseSettingsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const [action, setAction] = useState<string>(failure?.values?.breach_action ?? settings.breachAction);

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="response-target-title">
        <CardHeader id="response-target-title" title="יעד זמן תגובה לליד חדש" />
        <CardBody className="space-y-5">
          <TextField
            label="יעד בדקות"
            name="target_minutes"
            type="number"
            inputMode="numeric"
            min={TARGET_MIN}
            max={TARGET_MAX}
            step={1}
            dir="ltr"
            className="max-w-40"
            hint={`בין ${TARGET_MIN} ל-${TARGET_MAX} דקות. ${clockNote}`}
            defaultValue={failure?.values?.target_minutes ?? String(settings.targetMinutes)}
            error={errors.target_minutes}
          />

          <fieldset>
            <legend className="font-medium">כשליד לא נענה בזמן</legend>
            <div className="mt-3 space-y-2">
              {BREACH_ACTION_OPTIONS.map((option) => {
                // a business whose plan lost the flag keeps its saved choice until it picks another
                const locked = option.value === "pass_on" && !canPassOn && settings.breachAction !== "pass_on";
                return (
                  <label
                    key={option.value}
                    className={`flex gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft ${locked ? "opacity-70" : "cursor-pointer"}`}
                  >
                    <input
                      type="radio"
                      name="breach_action"
                      value={option.value}
                      checked={action === option.value}
                      disabled={locked}
                      onChange={() => setAction(option.value)}
                      className="mt-1 size-4 shrink-0 accent-accent"
                    />
                    <span>
                      <span className="block font-medium">{option.label}</span>
                      <span className="block text-sm text-ink-soft">{option.description}</span>
                      {option.value === "pass_on" && !canPassOn ? (
                        <span className="mt-1 block text-sm text-ink-soft">
                          לא כלול בחבילה הנוכחית. {settings.breachAction === "pass_on" ? "עד שיתווסף, המנהל מקבל התראה במקום העברה." : ""}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            {errors.breach_action ? <p className="mt-2 text-sm text-danger">{errors.breach_action}</p> : null}
          </fieldset>

          {action === "pass_on" ? (
            <TextField
              label="כמה פעמים להעביר ליד אחד"
              name="max_passes"
              type="number"
              inputMode="numeric"
              min={PASSES_MIN}
              max={PASSES_MAX}
              step={1}
              dir="ltr"
              className="max-w-40"
              hint={`בין ${PASSES_MIN} ל-${PASSES_MAX}. אחרי ההעברה האחרונה, אם עדיין לא נוצר קשר, רק המנהל מקבל התראה.`}
              defaultValue={failure?.values?.max_passes ?? String(settings.maxPasses)}
              error={errors.max_passes}
            />
          ) : (
            <input type="hidden" name="max_passes" value={String(settings.maxPasses)} />
          )}

          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}

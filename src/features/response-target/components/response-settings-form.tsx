"use client";

import { useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveResponseSettingsAction } from "../actions";
import { BREACH_ACTION_OPTIONS, TARGET_MAX, TARGET_MIN, type ResponseSettings } from "../settings";

type Props = { orgId: string; settings: ResponseSettings; clockNote: string };

/** The response target of a new lead and what happens when it is missed (CAP-10). Owners and admins. */
export function ResponseSettingsForm({ orgId, settings, clockNote }: Props) {
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
              {BREACH_ACTION_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft"
                >
                  <input
                    type="radio"
                    name="breach_action"
                    value={option.value}
                    checked={action === option.value}
                    onChange={() => setAction(option.value)}
                    className="mt-1 size-4 shrink-0 accent-accent"
                  />
                  <span>
                    <span className="block font-medium">{option.label}</span>
                    <span className="block text-sm text-ink-soft">{option.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {errors.breach_action ? <p className="mt-2 text-sm text-danger">{errors.breach_action}</p> : null}
          </fieldset>

          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}

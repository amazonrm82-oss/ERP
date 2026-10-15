"use client";

import { useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveDistributionAction } from "../actions";
import { WEIGHT_PREFIX } from "../schema";
import { DEFAULT_METHOD, METHOD_OPTIONS, WEIGHT_MAX, WEIGHT_MIN, weightOf, type DistributionSettings } from "../settings";

export type DistributionMember = { userId: string; name: string; available: boolean };

// canChoose: the plan holds 'lead_distribution'; without it only "סבב שווה" can be picked,
// and a saved other method shows with a note (the distribution ignores it).
type Props = { orgId: string; settings: DistributionSettings; members: DistributionMember[]; canChoose: boolean };

/** How automatic distribution chooses the next owner, and each member's weight (CAP-08). Owners and admins. */
export function DistributionForm({ orgId, settings, members, canChoose }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveDistributionAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const [method, setMethod] = useState<string>(failure?.values?.method ?? settings.method);

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="distribution-method-title">
        <CardHeader id="distribution-method-title" title="איך מחלקים לידים" />
        <CardBody className="space-y-5">
          <fieldset>
            <legend className="font-medium">שיטת החלוקה</legend>
            <div className="mt-3 space-y-2">
              {METHOD_OPTIONS.map((option) => {
                const locked = option.value !== DEFAULT_METHOD && !canChoose && settings.method !== option.value;
                return (
                  <label
                    key={option.value}
                    className={`flex gap-3 rounded-md border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft ${locked ? "opacity-70" : "cursor-pointer"}`}
                  >
                    <input
                      type="radio"
                      name="method"
                      value={option.value}
                      checked={method === option.value}
                      disabled={locked}
                      onChange={() => setMethod(option.value)}
                      className="mt-1 size-4 shrink-0 accent-accent"
                    />
                    <span>
                      <span className="block font-medium">{option.label}</span>
                      <span className="block text-sm text-ink-soft">{option.description}</span>
                      {option.value !== DEFAULT_METHOD && !canChoose ? (
                        <span className="mt-1 block text-sm text-ink-soft">
                          לא כלול בחבילה הנוכחית.{settings.method === option.value ? " עד שיתווסף, הלידים מחולקים בסבב שווה." : ""}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
            {errors.method ? <p className="mt-2 text-sm text-danger">{errors.method}</p> : null}
          </fieldset>

          <fieldset>
            <legend className="font-medium">משקל לכל עובד</legend>
            <p className="mt-1 text-sm text-ink-soft">
              {`מספר בין ${WEIGHT_MIN} ל-${WEIGHT_MAX}. משקל 2 מקבל פי שניים ממשקל 1. המשקל חל בחלוקה לפי משקל ולפי עומס פתוח.`}
            </p>
            {members.length === 0 ? (
              <p className="mt-3 text-sm text-ink-soft">אין עובדים שמקבלים לידים. מי שבתפקיד צופה או במושב צפייה לא מקבל לידים.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line rounded-md border border-line">
                {members.map((member) => {
                  const field = `${WEIGHT_PREFIX}${member.userId}`;
                  return (
                    <li key={member.userId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                      <span className="min-w-0 break-words">
                        <span className="block">{member.name}</span>
                        {member.available ? null : <span className="block text-sm text-ink-soft">מסומן כלא זמין, ולכן לא מקבל לידים כרגע</span>}
                      </span>
                      <TextField
                        label={`המשקל של ${member.name}`}
                        hideLabel
                        name={field}
                        type="number"
                        inputMode="numeric"
                        min={WEIGHT_MIN}
                        max={WEIGHT_MAX}
                        step={1}
                        dir="ltr"
                        controlSize="sm"
                        className="w-24"
                        defaultValue={failure?.values?.[field] ?? String(weightOf(settings.weights, member.userId))}
                        error={errors[field]}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>

          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}

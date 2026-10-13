"use client";

import { startTransition, useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FIELD_TYPE_LABELS, isFieldType } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";

import { saveConversionMapAction } from "../actions";
import {
  AUTO,
  autoTarget,
  choiceName,
  claimedTargets,
  currentChoice,
  MAP_TARGET_LABELS,
  MAP_TARGETS,
  NONE,
  offeredTargets,
  REMOVED,
  TARGET_REMOVED_NOTE,
  type MapField,
  type MapRow,
  type MapTarget,
} from "../rules";

type Props = {
  orgId: string;
  leadFields: MapField[];
  targets: Record<MapTarget, MapField[]>;
  rows: MapRow[];
  editable: boolean;
};

const typeLabel = (type: string) => (isFieldType(type) ? FIELD_TYPE_LABELS[type] : type);

/** LEAD-06: per lead custom field, the contact field and the deal field it goes to on conversion. */
export function ConversionMapForm({ orgId, leadFields, targets, rows, editable }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveConversionMapAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;

  return (
    // submitted by hand so the choices stay as picked after a failure
    <form
      className="space-y-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        startTransition(() => formAction(data));
      }}
    >
      <ul className="divide-y divide-line">
        {leadFields.map((lead) => (
          <li key={lead.id} className="py-4 first:pt-0">
            <p className="text-md font-medium text-ink">
              {lead.label}
              {!lead.isActive ? <span className="ms-2 text-sm font-normal text-ink-soft">(מוסתר)</span> : null}
            </p>
            <p className="text-sm text-ink-soft">{typeLabel(lead.type)}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {MAP_TARGETS.map((type) => {
                const offered = offeredTargets(lead, targets[type]);
                const auto = autoTarget(lead, targets[type], claimedTargets(rows, type));
                const stored = currentChoice(rows, lead.id, type);
                // a field picked earlier that is hidden or of another type by now: shown, and not copied
                const storedField = stored !== AUTO && stored !== NONE && stored !== REMOVED && !offered.some((t) => t.id === stored)
                  ? targets[type].find((t) => t.id === stored)
                  : undefined;
                return (
                  <SelectField
                    key={type}
                    label={`עובר אל ${MAP_TARGET_LABELS[type]}`}
                    name={choiceName(type, lead.id)}
                    defaultValue={stored}
                    disabled={!editable}
                    controlSize="sm"
                    error={stored === REMOVED ? TARGET_REMOVED_NOTE : undefined}
                  >
                    {stored === REMOVED ? <option value={REMOVED}>השדה שנבחר נמחק</option> : null}
                    <option value={AUTO}>{auto ? `העברה אוטומטית לפי שם: ${auto.label}` : "העברה אוטומטית לפי שם (אין כרגע שדה מתאים)"}</option>
                    <option value={NONE}>לא להעביר</option>
                    {storedField ? <option value={storedField.id}>{`${storedField.label} (לא פעיל, לא יועבר)`}</option> : null}
                    {offered.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </SelectField>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
      {editable ? (
        <>
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton pending={pending} size="sm">
            שמירה
          </SubmitButton>
        </>
      ) : null}
    </form>
  );
}

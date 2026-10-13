"use client";

import { startTransition, useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveCompletenessFieldsAction } from "../actions";
import { COMPLETENESS_TYPE_LABELS, type CompletenessField, type CompletenessType } from "../completeness";

type Props = {
  orgId: string;
  type: CompletenessType;
  catalog: CompletenessField[];
  selected: string[];
  editable: boolean;
};

/** DQL-01: the important fields of one record type, as boxes to tick (owners and admins). */
export function CompletenessSettingsForm({ orgId, type, catalog, selected, editable }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveCompletenessFieldsAction.bind(null, orgId, type), null);
  const failure = state && !state.ok ? state : null;
  const label = COMPLETENESS_TYPE_LABELS[type];
  const titleId = `completeness-${type}-title`;
  const builtIn = catalog.filter((f) => !f.key.startsWith("cf:"));
  const custom = catalog.filter((f) => f.key.startsWith("cf:"));

  const boxes = (fields: CompletenessField[]) => (
    <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      {fields.map((field) => (
        <Checkbox key={field.key} name="field" value={field.key} label={field.label} defaultChecked={selected.includes(field.key)} disabled={!editable} />
      ))}
    </div>
  );

  return (
    <Card aria-labelledby={titleId}>
      <CardHeader id={titleId} title={label.many} />
      <CardBody>
        {/* submitted by hand so the boxes keep what was ticked after a failure */}
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            startTransition(() => formAction(data));
          }}
        >
          <fieldset className="min-w-0">
            <legend className="mb-2 text-sm font-medium text-ink">שדות קבועים</legend>
            {boxes(builtIn)}
          </fieldset>
          {custom.length > 0 ? (
            <fieldset className="min-w-0">
              <legend className="mb-2 text-sm font-medium text-ink">שדות שהוספתם</legend>
              {boxes(custom)}
            </fieldset>
          ) : null}
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
      </CardBody>
    </Card>
  );
}

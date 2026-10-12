"use client";

import { useActionState, useState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { DisqualifyReasonField } from "@/features/disqualify-reasons/components/reason-field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { changeLeadStatusAction } from "../actions";
import type { LeadStatusOption } from "../queries";

// reasons: the organization's active "not relevant" reasons (LEAD-03); empty: typed in freely
type Props = { orgId: string; leadId: string; currentStatusId: string; statuses: LeadStatusOption[]; reasons: string[] };

/**
 * Status picker of a lead. The change is saved with an explicit button (not on
 * select change) so keyboard users can browse the options without saving each
 * one. A "not relevant" status asks for the reason first.
 * The parent remounts this component (key) when the saved status changes.
 */
export function LeadStatusForm({ orgId, leadId, currentStatusId, statuses, reasons }: Props) {
  const [selected, setSelected] = useState(currentStatusId);
  const [reason, setReason] = useState("");
  const [state, dispatch, pending] = useActionState<FormState, FormData>(
    changeLeadStatusAction.bind(null, orgId, leadId),
    null,
  );
  const failure = state && !state.ok ? state : null;

  // "converted" is set by the conversion itself, never picked by hand
  const options = statuses.filter((status) => status.kind !== "converted" || status.id === currentStatusId);
  const selectedStatus = statuses.find((status) => status.id === selected);
  const needsReason = selectedStatus?.kind === "disqualified";
  const changed = selected !== currentStatusId;

  return (
    // submitted by hand: the select is controlled (see submitWith)
    <form onSubmit={submitWith(dispatch)} className="space-y-3" noValidate>
      <SelectField label="סטטוס" name="status_id" value={selected} onChange={(event) => setSelected(event.target.value)}>
        {options.map((status) => (
          <option key={status.id} value={status.id}>
            {status.name}
          </option>
        ))}
      </SelectField>
      {changed && needsReason ? (
        <DisqualifyReasonField
          reasons={reasons}
          label="למה הליד לא רלוונטי?"
          name="disqualify_reason"
          value={reason}
          onChange={setReason}
          error={failure?.fieldErrors?.disqualify_reason}
        />
      ) : null}
      {failure && !failure.fieldErrors ? <FormError message={failure.message} /> : null}
      {changed ? (
        <SubmitButton size="sm" pending={pending} pendingText="מעדכנים…">
          עדכון סטטוס
        </SubmitButton>
      ) : null}
    </form>
  );
}

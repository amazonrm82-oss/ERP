"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { setPrivacyOfficerAction } from "../actions";
import type { OfficerCandidate } from "../officer";

/** PRK-06: owners and admins pick the business's privacy officer from its active members, or none. */
export function PrivacyOfficerForm({ orgId, officerId, candidates }: { orgId: string; officerId: string | null; candidates: OfficerCandidate[] }) {
  const [state, formAction] = useActionState<FormState, FormData>(setPrivacyOfficerAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const current = officerId && candidates.some((c) => c.userId === officerId) ? officerId : "";
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure?.message ?? null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SelectField label="אחראי פרטיות" name="privacy_officer_id" defaultValue={current} className="sm:max-w-sm">
        <option value="">אין</option>
        {candidates.map((candidate) => (
          <option key={candidate.userId} value={candidate.userId}>
            {candidate.name}
          </option>
        ))}
      </SelectField>
      <SubmitButton size="sm" pendingText="שומרים…">
        שמירת אחראי הפרטיות
      </SubmitButton>
    </form>
  );
}

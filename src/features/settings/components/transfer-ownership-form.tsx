"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { transferOwnershipAction } from "../actions";

type Props = { orgId: string; candidates: Array<{ userId: string; name: string }> };

/** Owner only. The new owner must be an active member with a full seat. */
export function TransferOwnershipForm({ orgId, candidates }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(transferOwnershipAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;

  if (state?.ok) {
    return <FormNotice message={state.message} />;
  }
  if (candidates.length === 0) {
    return <p className="text-md text-ink-soft">אין עדיין משתמש פעיל אחר שאפשר להעביר אליו את הבעלות.</p>;
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <p className="text-md text-ink-soft">
        הבעלים החדש יקבל את כל ההרשאות, כולל חיוב, והתפקיד שלך יהפוך ל&quot;מנהל מערכת&quot;. רק הבעלים החדש יוכל להחזיר את הבעלות.
      </p>
      <FormError message={failure?.message} />
      <SelectField label="הבעלים החדש" name="user_id" defaultValue="" error={failure?.fieldErrors?.user_id}>
        <option value="" disabled>
          בחירת משתמש
        </option>
        {candidates.map((candidate) => (
          <option key={candidate.userId} value={candidate.userId}>
            {candidate.name}
          </option>
        ))}
      </SelectField>
      <label className="flex items-start gap-2 text-md">
        <input type="checkbox" name="confirm" className="mt-1 size-4 accent-accent" />
        <span>ידוע לי שהבעלות על העסק תעבור למשתמש שבחרתי</span>
      </label>
      {failure?.fieldErrors?.confirm ? <p className="text-sm text-danger">{failure.fieldErrors.confirm}</p> : null}
      <SubmitButton variant="danger" pendingText="מעביר…">
        העברת הבעלות
      </SubmitButton>
    </form>
  );
}

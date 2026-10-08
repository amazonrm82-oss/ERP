"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { testRunAction } from "../actions";

type Props = { orgId: string; automationId: string; records: Array<{ id: string; name: string }> };

/** Runs the automation now on one chosen record. Its conditions are not checked. */
export function TestRunForm({ orgId, automationId, records }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(testRunAction.bind(null, orgId, automationId), null);
  if (records.length === 0) {
    return <p className="text-md text-ink-soft">אין עדיין רשומות מהסוג הזה לבדיקה.</p>;
  }
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <p className="text-sm text-ink-soft">הפעולות יבוצעו באמת על הרשומה שתבחרו (התנאים לא נבדקים). התוצאה מופיעה ביומן.</p>
      <div className="flex flex-wrap items-end gap-2">
        <SelectField label="רשומה לבדיקה" name="entity_id" defaultValue="" className="min-w-0 flex-[1_1_14rem]">
          <option value="" disabled>
            בחירה
          </option>
          {records.map((record) => (
            <option key={record.id} value={record.id}>
              {record.name}
            </option>
          ))}
        </SelectField>
        <SubmitButton variant="secondary" pendingText="מריץ…">
          הרצת בדיקה
        </SubmitButton>
      </div>
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
    </form>
  );
}

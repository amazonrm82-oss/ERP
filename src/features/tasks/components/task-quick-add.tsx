"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createTaskAction } from "../actions";

/** One-line "add a task for myself" form. `today` is the default due date (YYYY-MM-DD, organization time zone). */
export function TaskQuickAdd({ orgId, today }: { orgId: string; today: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createTaskAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;

  return (
    <form action={formAction} className="space-y-2" noValidate>
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          label="משימה חדשה"
          hideLabel
          name="title"
          placeholder="משימה חדשה, למשל: לחזור לדנה עם הצעת מחיר"
          maxLength={300}
          autoComplete="off"
          defaultValue={failure?.values?.title}
          className="min-w-0 flex-[1_1_10rem]"
        />
        <TextField
          label="תאריך יעד"
          hideLabel
          name="due_date"
          type="date"
          defaultValue={failure?.values?.due_date ?? today}
          className="flex-[0_1_9.5rem]"
        />
        <SubmitButton variant="secondary" pendingText="מוסיפים…">
          הוספה
        </SubmitButton>
      </div>
      <FormError message={failure?.message} />
    </form>
  );
}

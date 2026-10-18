"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createTaskAction } from "../actions";
import type { BusinessDaysContext } from "./business-days-picker";
import { TaskFields, type AssigneeOption } from "./task-fields";

type Props = {
  orgId: string;
  assignees: AssigneeOption[];
  myUserId: string;
  today: string;
  calendar?: BusinessDaysContext["calendar"];
  // TASK-06: a checklist template whose steps go into the new task
  templates?: Array<{ id: string; name: string }>;
};

/** New task, for oneself or for a colleague. The form clears itself after a successful save. */
export function TaskForm({ orgId, assignees, myUserId, today, calendar, templates = [] }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(createTaskAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TaskFields
        values={failure?.values ?? { due_date: today }}
        errors={failure?.fieldErrors ?? {}}
        assignees={assignees}
        defaultOwnerId={myUserId}
        businessDays={calendar ? { calendar, today } : undefined}
      />
      {templates.length > 0 ? (
        <SelectField label="רשימת תיוג" name="checklist_template" defaultValue={failure?.values?.checklist_template ?? ""}>
          <option value="">בלי</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </SelectField>
      ) : null}
      <SubmitButton pendingText="מוסיפים…">הוספת משימה</SubmitButton>
      {/* FXU-10: say that it worked; the form has cleared itself */}
      <FormNotice message={state?.ok ? (state.message ?? "המשימה נוספה.") : null} />
    </form>
  );
}

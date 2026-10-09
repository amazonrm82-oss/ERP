"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createTaskAction } from "../actions";
import { TaskFields, type AssigneeOption } from "./task-fields";

type Props = { orgId: string; assignees: AssigneeOption[]; myUserId: string; today: string };

/** New task, for oneself or for a colleague. The form clears itself after a successful save. */
export function TaskForm({ orgId, assignees, myUserId, today }: Props) {
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
      />
      <SubmitButton pendingText="מוסיפים…">הוספת משימה</SubmitButton>
      {/* FXU-10: say that it worked; the form has cleared itself */}
      <FormNotice message={state?.ok ? "המשימה נוספה." : null} />
    </form>
  );
}

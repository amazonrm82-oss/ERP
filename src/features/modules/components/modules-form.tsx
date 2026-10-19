"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveModulesAction } from "../actions";
import type { OrgModules } from "../modules";

type Props = { orgId: string; modules: OrgModules; leadsLabel: string };

/** LEAD-08: two switches, saved together. */
export function ModulesForm({ orgId, modules, leadsLabel }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveModulesAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-5">
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <Checkbox
        name="leads_enabled"
        defaultChecked={modules.leads}
        label={`מודול ${leadsLabel}`}
        hint="לעסק שעובד ישר עם אנשי קשר ועסקאות אפשר לכבות. כשהוא כבוי, הוא יורד מהתפריט ומהמסכים."
      />
      <Checkbox
        name="companies_enabled"
        defaultChecked={modules.companies}
        label="מודול החברות"
        hint="לעסק שמוכר לאנשים פרטיים אפשר לכבות. כשהוא כבוי, החברות יורדות מהתפריט, מהמסכים ומהטפסים."
      />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}

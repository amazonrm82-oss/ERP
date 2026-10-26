"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveQuickSalePipelineAction } from "../settings-actions";

type Props = { orgId: string; pipelines: { id: string; name: string; isDefault: boolean }[]; current: string | null };

/** GAP-08: the sales process a quick sale's won deal goes to. Owners and admins. */
export function QuickSalePipelineForm({ orgId, pipelines, current }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveQuickSalePipelineAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  // a setting that names a pipeline that is gone shows as the default, which is what a sale uses then
  const value = failure?.values?.quick_sale_pipeline_id ?? (current && pipelines.some((p) => p.id === current) ? current : "");
  return (
    <form action={formAction} noValidate className="space-y-4">
      <SelectField
        key={value}
        label="תהליך המכירה של מכירה מהירה"
        name="quick_sale_pipeline_id"
        defaultValue={value}
        hint="המכירה נרשמת כעסקה שנסגרה בהצלחה בתהליך הזה."
      >
        <option value="">תהליך ברירת המחדל</option>
        {pipelines.map((pipeline) => (
          <option key={pipeline.id} value={pipeline.id}>
            {pipeline.name}
            {pipeline.isDefault ? " (ברירת מחדל)" : ""}
          </option>
        ))}
      </SelectField>
      <FormError message={failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}

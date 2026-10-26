"use client";

import { useActionState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { addToBlocklistAction } from "../actions";
import { BLOCKLIST_ADD_MAX, BLOCKLIST_CHANNEL_LABELS, BLOCKLIST_CHANNELS, BLOCKLIST_REASON_LABELS, BLOCKLIST_REASONS } from "../model";

/** CNS-06: one address or a pasted list, a channel and a reason. The addresses are hashed by the database. */
export function BlocklistAddForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(addToBlocklistAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  const values = failed?.values ?? {};
  return (
    <form action={formAction} className="space-y-4" key={state?.ok ? state.message : "form"}>
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
      <TextareaField
        label="טלפונים או אימיילים"
        name="addresses"
        rows={4}
        dir="ltr"
        required
        defaultValue={values.addresses ?? ""}
        error={failed?.fieldErrors?.addresses}
        hint={`אחד בכל שורה, או מופרדים בפסיק. עד ${BLOCKLIST_ADD_MAX} בבת אחת.`}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="ערוץ" name="channel" defaultValue={values.channel ?? "all"} error={failed?.fieldErrors?.channel}>
          {BLOCKLIST_CHANNELS.map((channel) => (
            <option key={channel} value={channel}>
              {BLOCKLIST_CHANNEL_LABELS[channel]}
            </option>
          ))}
        </SelectField>
        <SelectField label="סיבה" name="reason" defaultValue={values.reason ?? "person_request"} error={failed?.fieldErrors?.reason}>
          {BLOCKLIST_REASONS.map((reason) => (
            <option key={reason} value={reason}>
              {BLOCKLIST_REASON_LABELS[reason]}
            </option>
          ))}
        </SelectField>
      </div>
      <SubmitButton pendingText="מוסיפים…">הוספה לרשימה</SubmitButton>
    </form>
  );
}

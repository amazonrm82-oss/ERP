"use client";

import { useActionState } from "react";

import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import type { FormState } from "@/lib/action-result";

import { savePunchSettingsAction } from "../actions";
import { PUNCH_ENTRIES_MAX, PUNCH_VALIDITY_MAX } from "../balance";
import type { PunchSettings } from "../queries";

/** PKG-01: entries, validity and the meeting types a punch card product covers. */
export function PunchSettingsForm({
  orgId,
  productId,
  settings,
  meetingTypes,
}: {
  orgId: string;
  productId: string;
  settings: PunchSettings;
  meetingTypes: { id: string; name: string; active: boolean }[];
}) {
  const [state, formAction] = useActionState<FormState, FormData>(savePunchSettingsAction.bind(null, orgId, productId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const typed = failure?.values;
  const picked = new Set(settings.meetingTypeIds);
  // a type that is no longer listed stays checked only while it is still in the business's list
  const shown = meetingTypes.filter((type) => type.active || picked.has(type.id));
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormGuard state={state} />
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
      <TextField
        label="מספר כניסות"
        name="entries"
        dir="ltr"
        inputMode="numeric"
        required
        className="sm:max-w-48"
        max={PUNCH_ENTRIES_MAX}
        defaultValue={typed?.entries ?? (settings.entries !== null ? String(settings.entries) : "")}
        error={errors.entries}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="תוקף מההפעלה"
          hint="ריק: בלי תוקף."
          name="validity_count"
          dir="ltr"
          inputMode="numeric"
          max={PUNCH_VALIDITY_MAX}
          defaultValue={typed?.validity_count ?? (settings.validityCount !== null ? String(settings.validityCount) : "")}
          error={errors.validity_count}
        />
        <SelectField label="יחידה" name="validity_unit" defaultValue={typed?.validity_unit ?? settings.validityUnit ?? "months"} error={errors.validity_unit}>
          <option value="months">חודשים</option>
          <option value="days">ימים</option>
        </SelectField>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">סוגי הפגישה שהכרטיסייה חלה עליהם</legend>
        <p className="text-sm text-ink-soft">פגישה מאחד הסוגים האלה שמסומנת &quot;התקיימה&quot; מורידה כניסה מהכרטיסייה של איש הקשר.</p>
        {shown.length === 0 ? (
          <p className="text-sm text-ink-soft">אין סוגי פגישה בעסק. מוסיפים אותם בהגדרות היומן.</p>
        ) : (
          shown.map((type) => (
            <Checkbox key={type.id} name="meeting_type_ids" value={type.id} label={type.active ? type.name : `${type.name} (מוסתר)`} defaultChecked={picked.has(type.id)} />
          ))
        )}
        {errors.meeting_type_ids ? <p className="text-sm text-danger">{errors.meeting_type_ids}</p> : null}
      </fieldset>
      <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
    </form>
  );
}

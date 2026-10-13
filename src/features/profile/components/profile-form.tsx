"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { saveProfileAction } from "../actions";
import type { MyProfile } from "../queries";

type Props = {
  orgId: string;
  profile: Omit<MyProfile, "avatarUrl">;
  // the organization's time zone, used when the user has none of their own
  orgTimeZone: string;
  // IANA names, from the server so the list matches what the server accepts
  timeZones: string[];
};

/** Name, phone, language, time zone and signature (USR-01). Working hours have their own form (CAP-09). */
export function ProfileForm({ orgId, profile, orgTimeZone, timeZones }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveProfileAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  const [timeZone, setTimeZone] = useState(profile.timeZone ?? "");

  return (
    // submitted by hand: the time zone is controlled (see submitWith)
    <form onSubmit={submitWith(formAction)} className="space-y-5" noValidate>
      <FormError message={failed?.message ?? null} />
      <FormNotice message={state?.ok ? state.message : null} />

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="שם מלא"
          name="full_name"
          required
          maxLength={120}
          autoComplete="name"
          defaultValue={profile.fullName}
          error={failed?.fieldErrors?.full_name}
        />
        <TextField
          label="טלפון"
          name="phone"
          type="tel"
          dir="ltr"
          maxLength={24}
          autoComplete="tel"
          defaultValue={profile.phone}
          error={failed?.fieldErrors?.phone}
        />
        <SelectField label="שפה" name="locale" defaultValue="he" hint="אנגלית תתווסף בהמשך." error={failed?.fieldErrors?.locale}>
          <option value="he">עברית</option>
        </SelectField>
        <SelectField
          label="אזור זמן"
          name="timezone"
          value={timeZone}
          onChange={(e) => setTimeZone(e.target.value)}
          hint="שעות העבודה, החופשות והתזכורות שלכם לפיו."
          error={failed?.fieldErrors?.timezone}
        >
          <option value="">{`כמו העסק (${orgTimeZone})`}</option>
          {timeZones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </SelectField>
      </div>


      <TextareaField
        label="חתימה להודעות"
        name="signature"
        rows={4}
        maxLength={500}
        defaultValue={profile.signature}
        hint="תצורף בסוף הודעות שתשלחו מתוך המערכת. עד 500 תווים."
        error={failed?.fieldErrors?.signature}
      />

      <SubmitButton pendingText="שומרים…" pending={pending}>
        שמירת הפרטים
      </SubmitButton>
    </form>
  );
}

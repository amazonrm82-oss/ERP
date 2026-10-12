"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Input, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { saveProfileAction } from "../actions";
import type { MyProfile } from "../queries";
import { DEFAULT_WORKING_HOURS, WEEKDAYS, type Weekday, type WorkingHours } from "../working-hours";

type Props = {
  orgId: string;
  profile: Omit<MyProfile, "avatarUrl">;
  // the organization's time zone, used when the user has none of their own
  orgTimeZone: string;
  // IANA names, from the server so the list matches what the server accepts
  timeZones: string[];
};

/** Name, phone, language, time zone, working hours and signature (USR-01). */
export function ProfileForm({ orgId, profile, orgTimeZone, timeZones }: Props) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveProfileAction.bind(null, orgId), null);
  const failed = state && !state.ok ? state : null;
  const initialHours: WorkingHours = profile.workingHours ?? DEFAULT_WORKING_HOURS;
  const [days, setDays] = useState<Record<Weekday, boolean>>(
    () => Object.fromEntries(WEEKDAYS.map(({ key }) => [key, Boolean(initialHours[key])])) as Record<Weekday, boolean>,
  );
  const [timeZone, setTimeZone] = useState(profile.timeZone ?? "");

  return (
    // submitted by hand: the checkboxes and the time zone are controlled (see submitWith)
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
          hint="שעות העבודה והתזכורות שלכם לפיו."
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

      <fieldset aria-describedby="working-hours-hint">
        <legend className="text-md font-medium text-ink">שעות עבודה</legend>
        <p id="working-hours-hint" className="mt-1 text-sm text-ink-soft">
          סמנו את הימים שבהם אתם עובדים. היומן וזמני התגובה ייעזרו בהם.
        </p>
        {failed?.fieldErrors?.working_hours ? (
          <p role="alert" className="mt-1 text-sm text-danger">
            {failed.fieldErrors.working_hours}
          </p>
        ) : null}
        <ul className="mt-3 divide-y divide-line rounded-md border border-line">
          {WEEKDAYS.map(({ key, label }) => {
            const on = days[key];
            const hours = initialHours[key] ?? { start: "09:00", end: "17:00" };
            return (
              <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                <label className="flex min-h-11 w-24 items-center gap-2 text-md text-ink">
                  <input
                    type="checkbox"
                    name={`day_${key}`}
                    checked={on}
                    onChange={(e) => setDays((current) => ({ ...current, [key]: e.target.checked }))}
                    className="size-5 shrink-0 rounded-sm border-line-control accent-[var(--color-accent)]"
                  />
                  {label}
                </label>
                {on ? (
                  <span className="flex items-center gap-2">
                    <Input
                      type="time"
                      name={`start_${key}`}
                      defaultValue={failed?.values?.[`start_${key}`] ?? hours.start}
                      aria-label={`שעת התחלה ביום ${label}`}
                      controlSize="sm"
                      className="w-28"
                      dir="ltr"
                      required
                    />
                    <span className="text-sm text-ink-soft">עד</span>
                    <Input
                      type="time"
                      name={`end_${key}`}
                      defaultValue={failed?.values?.[`end_${key}`] ?? hours.end}
                      aria-label={`שעת סיום ביום ${label}`}
                      controlSize="sm"
                      className="w-28"
                      dir="ltr"
                      required
                    />
                  </span>
                ) : (
                  <span className="text-sm text-ink-soft">לא עובדים</span>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

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

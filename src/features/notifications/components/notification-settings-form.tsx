"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { saveNotificationSettingsAction } from "../actions";
import { QUIET_HOURS_DEFAULT, QUIET_HOURS_HELP, quietHoursFormLine, type QuietHours } from "../quiet-hours";
import { shownNotificationGroups, type DeliveryChoice, type NotificationSettings } from "../settings";

const GROUPS = shownNotificationGroups();

/**
 * Per kind of notification: in the bell and on the phone, in the bell only, or not at all.
 * USR-11: quiet hours, in which the phone push waits for the window's end.
 */
export function NotificationSettingsForm({ orgId, settings, quiet }: { orgId: string; settings: NotificationSettings; quiet: QuietHours }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveNotificationSettingsAction.bind(null, orgId), null);
  const [choices, setChoices] = useState(settings);
  const [quietOn, setQuietOn] = useState(quiet !== null);
  const [quietFrom, setQuietFrom] = useState<string>(quiet?.from ?? QUIET_HOURS_DEFAULT.from);
  const [quietUntil, setQuietUntil] = useState<string>(quiet?.until ?? QUIET_HOURS_DEFAULT.until);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    // submitted by hand: the selects are controlled (see submitWith)
    <form onSubmit={submitWith(formAction)} className="space-y-4">
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      {GROUPS.map((group) => (
        <fieldset key={group.key} className="space-y-2">
          <legend className="font-semibold">{group.label}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.kinds.map((kind) => (
              <SelectField
                key={kind.key}
                label={kind.label}
                name={`kind_${kind.key}`}
                value={choices[kind.key]}
                onChange={(e) => setChoices((current) => ({ ...current, [kind.key]: e.target.value as DeliveryChoice }))}
                controlSize="sm"
              >
                <option value="all">בפעמון ובטלפון</option>
                <option value="bell">רק בפעמון</option>
                <option value="off">לא לקבל</option>
              </SelectField>
            ))}
          </div>
        </fieldset>
      ))}
      <fieldset className="space-y-3">
        <legend className="font-semibold">שעות שקט</legend>
        <Checkbox
          name="quiet_enabled"
          label="להפעיל שעות שקט"
          hint={`${QUIET_HOURS_HELP}.`}
          checked={quietOn}
          onChange={(e) => setQuietOn(e.target.checked)}
        />
        {quietOn ? (
          <>
            <div className="flex flex-wrap gap-4">
              <TextField
                label="מהשעה"
                name="quiet_from"
                type="time"
                step={60}
                dir="ltr"
                className="w-36"
                required
                value={quietFrom}
                onChange={(e) => setQuietFrom(e.target.value)}
                error={errors.quiet_from}
              />
              <TextField
                label="עד השעה"
                name="quiet_until"
                type="time"
                step={60}
                dir="ltr"
                className="w-36"
                required
                value={quietUntil}
                onChange={(e) => setQuietUntil(e.target.value)}
                error={errors.quiet_until}
              />
            </div>
            <p className="text-sm text-ink-soft">{quietHoursFormLine(quietFrom, quietUntil)}</p>
          </>
        ) : null}
      </fieldset>
      <p className="text-sm text-ink-soft">
        הבחירה חלה בכל העסקים שלכם. התראות אבטחה (כמו איפוס אימות דו-שלבי) מגיעות תמיד. כדי לקבל התראות בטלפון צריך גם להפעיל אותן בדף ההתראות, בכל מכשיר.
      </p>
      <SubmitButton pendingText="שומרים…" pending={pending}>
        שמירת ההעדפות
      </SubmitButton>
    </form>
  );
}

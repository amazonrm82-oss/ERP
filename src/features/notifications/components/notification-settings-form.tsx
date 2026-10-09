"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { saveNotificationSettingsAction } from "../actions";
import { NOTIFICATION_KINDS, type DeliveryChoice, type NotificationSettings } from "../settings";

/** Per kind of notification: in the bell and on the phone, in the bell only, or not at all. */
export function NotificationSettingsForm({ orgId, settings }: { orgId: string; settings: NotificationSettings }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveNotificationSettingsAction.bind(null, orgId), null);
  const [choices, setChoices] = useState(settings);
  return (
    // submitted by hand: the selects are controlled (see submitWith)
    <form onSubmit={submitWith(formAction)} className="space-y-4">
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <div className="grid gap-3 sm:grid-cols-2">
        {NOTIFICATION_KINDS.map((kind) => (
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
      <p className="text-sm text-ink-soft">
        הבחירה חלה בכל העסקים שלכם. התראות אבטחה (כמו איפוס אימות דו-שלבי) מגיעות תמיד. כדי לקבל התראות בטלפון צריך גם להפעיל אותן בדף ההתראות, בכל מכשיר.
      </p>
      <SubmitButton pendingText="שומרים…" pending={pending}>
        שמירת ההעדפות
      </SubmitButton>
    </form>
  );
}

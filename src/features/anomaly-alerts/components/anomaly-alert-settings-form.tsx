"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveAnomalyAlertSettingsAction } from "../actions";
import { ANOMALY_BOUNDS, type AnomalyAlertSettings } from "../settings";

type Props = { orgId: string; settings: AnomalyAlertSettings };

type Alert = {
  legend: string;
  switchName: "lead_drop_on" | "idle_rep_on" | "quiet_form_on" | "campaign_jump_on";
  switchLabel: string;
  on: boolean;
  numberName: keyof typeof ANOMALY_BOUNDS;
  numberLabel: string;
  unit: string;
  value: number;
};

/** MNY-04 (285) ג: a switch and a threshold for each anomaly alert. Owners and admins of a writable business. */
export function AnomalyAlertSettingsForm({ orgId, settings }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveAnomalyAlertSettingsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};

  const alerts: Alert[] = [
    {
      legend: "ירידה חדה בפניות ממקור קבוע",
      switchName: "lead_drop_on",
      switchLabel: "להתריע על ירידה חדה בפניות",
      on: settings.leadDropOn,
      numberName: "lead_drop_percent",
      numberLabel: "ירידה של יותר מ- (אחוזים מהממוצע השבועי)",
      unit: "אחוזים",
      value: settings.leadDropPercent,
    },
    {
      legend: "מישהו בצוות שלא עדכן רשומות",
      switchName: "idle_rep_on",
      switchLabel: "להתריע על מי שלא עדכן רשומות",
      on: settings.idleRepOn,
      numberName: "idle_rep_days",
      numberLabel: "אחרי כמה ימי עבודה שלו בלי עדכון",
      unit: "ימים",
      value: settings.idleRepDays,
    },
    {
      legend: "טופס שהפסיק לקבל פניות",
      switchName: "quiet_form_on",
      switchLabel: "להתריע על טופס שהפסיק לקבל פניות",
      on: settings.quietFormOn,
      numberName: "quiet_form_min_inquiries",
      numberLabel: "טופס נחשב קבוע מכמה פניות בחודש שלפני",
      unit: "פניות",
      value: settings.quietFormMinInquiries,
    },
    {
      legend: "קפיצה בעלות לפנייה של קמפיין",
      switchName: "campaign_jump_on",
      switchLabel: "להתריע על קפיצה בעלות לפנייה",
      on: settings.campaignJumpOn,
      numberName: "campaign_jump_percent",
      numberLabel: "עלייה של לפחות (אחוזים לעומת 3 החודשים שלפני)",
      unit: "אחוזים",
      value: settings.campaignJumpPercent,
    },
  ];

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="anomaly-alerts-title">
        <CardHeader id="anomaly-alerts-title" title="התראות חריגה" />
        <CardBody className="space-y-5">
          <p className="text-sm text-ink-soft">פעם ביום, מ-8:00 בבוקר, הבעלים ומנהלי המערכת מקבלים התראה כשמשהו חריג. ההתראה אומרת כמה, בלי שמות.</p>
          {alerts.map((alert) => {
            const { min, max } = ANOMALY_BOUNDS[alert.numberName];
            return (
              <fieldset key={alert.switchName} className="space-y-3 border-t border-line pt-4">
                <legend className="text-md font-semibold text-ink">{alert.legend}</legend>
                <Checkbox
                  name={alert.switchName}
                  label={alert.switchLabel}
                  defaultChecked={failure?.values ? failure.values[alert.switchName] === "on" : alert.on}
                />
                <TextField
                  label={alert.numberLabel}
                  name={alert.numberName}
                  type="number"
                  inputMode="numeric"
                  min={min}
                  max={max}
                  step={1}
                  dir="ltr"
                  className="max-w-40"
                  hint={`בין ${min} ל-${max} ${alert.unit}.`}
                  defaultValue={failure?.values?.[alert.numberName] ?? String(alert.value)}
                  error={errors[alert.numberName]}
                />
              </fieldset>
            );
          })}
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}

"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { createReportScheduleAction } from "../actions";
import { SCHEDULE_PERIODS, SCHEDULE_TIMES, WEEKDAYS } from "../catalog";

export type ScheduleReportOption = { key: string; title: string; hasPeriod: boolean; restricted: boolean };
export type ScheduleMemberOption = { userId: string; name: string; managerOrAbove: boolean };

/**
 * RPT-03 (owner (386) א): a new scheduled report. The email holds only the report's name, the period and a link; each
 * recipient opens the report with their own sign-in. A restricted report offers owners, admins and managers only.
 */
export function ScheduleForm({ orgId, reports, members }: { orgId: string; reports: ScheduleReportOption[]; members: ScheduleMemberOption[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(createReportScheduleAction.bind(null, orgId), null);
  const [reportKey, setReportKey] = useState(reports[0]?.key ?? "");
  const [frequency, setFrequency] = useState<"daily" | "weekly">("weekly");
  const report = reports.find((r) => r.key === reportKey);
  const offered = report?.restricted ? members.filter((m) => m.managerOrAbove) : members;
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <form onSubmit={submitWith(formAction)} className="space-y-4" noValidate>
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label="דוח" name="report" value={reportKey} onChange={(e) => setReportKey(e.target.value)} error={errors.report} required>
          {reports.map((r) => (
            <option key={r.key} value={r.key}>
              {r.title}
            </option>
          ))}
        </SelectField>
        {report?.hasPeriod ? (
          <SelectField label="תקופה" name="period" defaultValue="last_7" error={errors.period} required>
            {SCHEDULE_PERIODS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </SelectField>
        ) : (
          <p className="self-end text-sm text-ink-soft">הדוח הזה מציג את המצב הנוכחי, בלי תקופה.</p>
        )}
        <SelectField
          label="תדירות"
          name="frequency"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value === "daily" ? "daily" : "weekly")}
          error={errors.frequency}
        >
          <option value="weekly">פעם בשבוע</option>
          <option value="daily">כל יום עבודה</option>
        </SelectField>
        {frequency === "weekly" ? (
          <SelectField label="יום בשבוע" name="weekday" defaultValue="0" error={errors.weekday}>
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={String(index)}>
                יום {day}
              </option>
            ))}
          </SelectField>
        ) : null}
        <SelectField label="שעת השליחה (לפי שעון העסק)" name="send_at" defaultValue="08:00" error={errors.send_at}>
          {SCHEDULE_TIMES.map((time) => (
            <option key={time} value={time} dir="ltr">
              {time}
            </option>
          ))}
        </SelectField>
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-md font-medium">נמענים</legend>
        {report?.restricted ? <p className="text-sm text-ink-soft">את הדוח הזה מקבלים רק בעלים, מנהלי מערכת ומנהלים.</p> : null}
        <div className="grid gap-2 sm:grid-cols-2" key={report?.restricted ? "restricted" : "all"}>
          {offered.map((m) => (
            <Checkbox key={m.userId} name="recipients" value={m.userId} label={m.name} />
          ))}
        </div>
        {errors.recipients ? (
          <p role="alert" className="text-sm text-danger">
            {errors.recipients}
          </p>
        ) : null}
      </fieldset>
      <p className="text-sm text-ink-soft">
        המייל כולל רק את שם הדוח, התקופה וקישור לדוח, בלי מספרים. כל נמען פותח את הדוח בכניסה שלו ורואה רק את מה שמותר לו לראות.
      </p>
      <SubmitButton pendingText="שומרים…" pending={pending}>
        שמירת הדוח המתוזמן
      </SubmitButton>
    </form>
  );
}

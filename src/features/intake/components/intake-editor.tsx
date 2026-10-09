"use client";

import { useActionState, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Label, SelectField, Textarea, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createIntakeAction, updateIntakeAction } from "../actions";
import { INTAKE_FIELD_LABELS, INTAKE_FIELDS } from "../fields";
import type { IntakeDetails } from "../queries";

type Option = { id: string; name: string };

export function CreateIntakeForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createIntakeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-start">
        <TextField
          label="שם"
          name="name"
          required
          maxLength={80}
          autoComplete="off"
          placeholder="למשל: טופס צור קשר באתר"
          defaultValue={failure?.values?.name}
          error={failure?.fieldErrors?.name}
        />
        <SelectField label="סוג" name="kind" defaultValue={failure?.values?.kind ?? "form"}>
          <option value="form">טופס לאתר</option>
          <option value="webhook">Webhook</option>
        </SelectField>
        <SubmitButton className="sm:mt-6.5" pendingText="יוצרים…">
          יצירה
        </SubmitButton>
      </div>
    </form>
  );
}

type EditProps = { orgId: string; intake: IntakeDetails; sources: Option[]; members: Option[]; teams: Option[] };

export function IntakeSettingsForm({ orgId, intake, sources, members, teams }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateIntakeAction.bind(null, orgId, intake.id), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const isForm = intake.kind === "form";
  const shown = (key: string) => (values ? values[`show_${key}`] === "on" : intake.fields.some((field) => field.key === key));
  const required = (key: string) =>
    values ? values[`required_${key}`] === "on" : intake.fields.some((field) => field.key === key && field.required);
  const sourceValue = values?.source_id ?? intake.sourceId ?? "";
  const ownerValue = values?.owner_id ?? intake.ownerId ?? "";
  const teamValue = values?.team_id ?? intake.teamId ?? "";
  const [mode, setMode] = useState(values?.assign_mode ?? intake.assignMode);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <TextField label="שם פנימי" name="name" required maxLength={80} autoComplete="off" defaultValue={values?.name ?? intake.name} error={errors.name} />

      {isForm ? (
        <>
          <TextField label="כותרת הטופס" name="title" maxLength={120} autoComplete="off" defaultValue={values?.title ?? intake.title ?? ""} error={errors.title} />
          <TextareaField label="טקסט מעל הטופס (לא חובה)" name="intro" rows={2} maxLength={500} defaultValue={values?.intro ?? intake.intro ?? ""} error={errors.intro} />
          <fieldset className="rounded-md border border-line p-3">
            <legend className="px-1 text-sm font-medium">שדות בטופס</legend>
            <div className="divide-y divide-line">
              {INTAKE_FIELDS.map((key) => (
                <div key={`${key}-${shown(key)}-${required(key)}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <label className="flex items-center gap-2 text-md">
                    <input type="checkbox" name={`show_${key}`} defaultChecked={shown(key)} className="size-4.5 accent-accent" />
                    {INTAKE_FIELD_LABELS[key]}
                  </label>
                  <label className="flex items-center gap-2 text-sm text-ink-soft">
                    <input type="checkbox" name={`required_${key}`} defaultChecked={required(key)} className="size-4 accent-accent" />
                    חובה
                    <span className="sr-only">: {INTAKE_FIELD_LABELS[key]}</span>
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="טקסט הכפתור" name="submit_label" maxLength={40} autoComplete="off" placeholder="שליחה" defaultValue={values?.submit_label ?? intake.submitLabel ?? ""} error={errors.submit_label} />
            <TextField
              label="מעבר לדף אחרי שליחה (לא חובה)"
              name="redirect_url"
              dir="ltr"
              inputMode="url"
              autoComplete="off"
              placeholder="https://example.co.il/thanks"
              defaultValue={values?.redirect_url ?? intake.redirectUrl ?? ""}
              error={errors.redirect_url}
            />
          </div>
          <TextField
            label="הודעת תודה"
            name="success_message"
            maxLength={300}
            autoComplete="off"
            placeholder="תודה! קיבלנו את הפרטים ונחזור אליכם בהקדם."
            defaultValue={values?.success_message ?? intake.successMessage ?? ""}
            error={errors.success_message}
          />
        </>
      ) : null}

      <SelectField key={`source-${sourceValue}`} label="מקור הליד" name="source_id" defaultValue={sourceValue} error={errors.source_id}>
        <option value="">ללא מקור</option>
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </SelectField>

      <fieldset className="space-y-4 rounded-md border border-line p-3">
        <legend className="px-1 text-sm font-medium">למי הולך ליד חדש</legend>
        <div className="space-y-2">
          <label className="flex items-start gap-2.5 text-md">
            <input
              type="radio"
              name="assign_mode"
              value="owner"
              checked={mode === "owner"}
              onChange={() => setMode("owner")}
              className="mt-1 size-4 accent-accent"
            />
            <span>לחבר צוות קבוע</span>
          </label>
          <label className="flex items-start gap-2.5 text-md">
            <input
              type="radio"
              name="assign_mode"
              value="round_robin"
              checked={mode === "round_robin"}
              onChange={() => setMode("round_robin")}
              className="mt-1 size-4 accent-accent"
            />
            <span>
              בסבב בין חברי הצוות הזמינים
              <span className="block text-sm text-ink-soft">כל ליד הולך למי שקיבל ליד הכי מזמן. מי שסימן שהוא לא זמין מדולג.</span>
            </span>
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {mode === "round_robin" ? (
            <SelectField key={`team-${teamValue}`} label="מי משתתף בסבב" name="team_id" defaultValue={teamValue} error={errors.team_id}>
              <option value="">כל המשתמשים בעסק</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  צוות {team.name}
                </option>
              ))}
            </SelectField>
          ) : (
            <input type="hidden" name="team_id" value={teamValue} />
          )}
          <SelectField
            key={`owner-${ownerValue}`}
            label={mode === "round_robin" ? "אם אף אחד לא זמין" : "חבר הצוות"}
            name="owner_id"
            defaultValue={ownerValue}
            error={errors.owner_id}
            hint="בלי אחראי: רק הבעלים ומנהלי המערכת יראו את הליד, אלא אם כולם רואים הכול."
          >
            <option value="">ללא אחראי</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </SelectField>
        </div>
      </fieldset>
      <label className="flex items-center gap-2.5 text-md">
        <input type="checkbox" name="is_active" defaultChecked={values ? values.is_active === "on" : intake.isActive} className="size-4.5 accent-accent" />
        פעיל (מקבל פניות)
      </label>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <SubmitButton>שמירה</SubmitButton>
    </form>
  );
}

/** A read-only snippet with a copy button. */
export function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Textarea
        id={id}
        value={value}
        readOnly
        dir="ltr"
        rows={Math.min(8, value.split("\n").length + 1)}
        className="font-mono text-sm"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button
        variant="secondary"
        size="sm"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "הועתק" : "העתקה"}
        <span className="sr-only">: {label}</span>
      </Button>
    </div>
  );
}

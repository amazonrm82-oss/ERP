"use client";

import { useActionState, useId, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Input, Label, SelectField, Textarea, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import type { Json } from "@/lib/database.types";

import { createIntakeAction, updateIntakeAction } from "../actions";
import { parseFieldsConfig, storedFields, type FormFieldConfig, type FormFieldOption } from "../fields";
import { FormFieldsBuilder } from "./form-fields-builder";
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

// businessPhone: the business phone as typed, when a WhatsApp chat can open it, else null (CAP-05)
type EditProps = {
  orgId: string;
  intake: IntakeDetails;
  sources: Option[];
  members: Option[];
  teams: Option[];
  fieldOptions: FormFieldOption[];
  businessPhone: string | null;
};

/** The builder's JSON (camelCase) in the stored shape, for parseFieldsConfig. */
function fieldsJsonToStored(json: string): Json {
  try {
    const list: unknown = JSON.parse(json);
    return Array.isArray(list) ? storedFields(list as FormFieldConfig[]) : [];
  } catch {
    return [];
  }
}

export function IntakeSettingsForm({ orgId, intake, sources, members, teams, fieldOptions, businessPhone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(updateIntakeAction.bind(null, orgId, intake.id), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const isForm = intake.kind === "form";
  // after a failed save, the builder starts from what was sent
  const builderInitial = values?.fields_json ? parseFieldsConfig(fieldsJsonToStored(values.fields_json)) : intake.fields;
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
          <FormFieldsBuilder key={values?.fields_json ?? "saved"} initial={builderInitial} options={fieldOptions} />
          <TextField label="טקסט הכפתור" name="submit_label" maxLength={40} autoComplete="off" placeholder="שליחת הפרטים" defaultValue={values?.submit_label ?? intake.submitLabel ?? ""} error={errors.submit_label} />
          <ThanksSettings intake={intake} businessPhone={businessPhone} values={values} errors={errors} />
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

/**
 * CAP-05: what the person sees after sending: the thank-you message, with an
 * optional WhatsApp button, or a page of the business's own (which wins).
 */
function ThanksSettings({
  intake,
  businessPhone,
  values,
  errors,
}: {
  intake: IntakeDetails;
  businessPhone: string | null;
  values: Record<string, string> | undefined;
  errors: Record<string, string>;
}) {
  const [whatsapp, setWhatsapp] = useState(values ? values.whatsapp_button === "on" : intake.whatsappButton);
  return (
    <fieldset className="space-y-4 rounded-md border border-line p-3">
      <legend className="px-1 text-sm font-medium">אחרי השליחה</legend>
      <TextField
        label="הודעת תודה"
        name="success_message"
        maxLength={300}
        autoComplete="off"
        placeholder="תודה! קיבלנו את הפרטים ונחזור אליכם בהקדם."
        defaultValue={values?.success_message ?? intake.successMessage ?? ""}
        error={errors.success_message}
      />
      <div className="space-y-3">
        <label className="flex items-start gap-2.5 text-md">
          <input
            type="checkbox"
            name="whatsapp_button"
            checked={whatsapp}
            onChange={(event) => setWhatsapp(event.currentTarget.checked)}
            className="mt-1 size-4.5 accent-accent"
          />
          <span>
            כפתור WhatsApp בהודעת התודה
            <span className="block text-sm text-ink-soft">מי שמילא את הטופס יכול לפתוח שיחה עם העסק בלחיצה.</span>
          </span>
        </label>
        {whatsapp ? (
          <>
            <p className="rounded-md bg-warning-soft px-3 py-2.5 text-sm text-warning">
              המספר יוצג לכל מי שפותח את הטופס: המספר שכאן, ואם הוא ריק, הטלפון שבפרטי העסק.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="מספר ל-WhatsApp"
                name="whatsapp_phone"
                type="tel"
                dir="ltr"
                inputMode="tel"
                maxLength={30}
                autoComplete="off"
                placeholder={businessPhone ?? "050-1234567"}
                defaultValue={values?.whatsapp_phone ?? intake.whatsappPhone ?? ""}
                error={errors.whatsapp_phone}
                hint={businessPhone ? "ריק: הטלפון שבפרטי העסק." : "בפרטי העסק אין טלפון, לכן צריך מספר כאן."}
              />
              <TextareaField
                label="הודעה מוכנה בשיחה (לא חובה)"
                name="whatsapp_text"
                rows={2}
                maxLength={300}
                placeholder="היי, מילאתי עכשיו את הטופס באתר"
                defaultValue={values?.whatsapp_text ?? intake.whatsappText ?? ""}
                error={errors.whatsapp_text}
              />
            </div>
          </>
        ) : null}
      </div>
      <TextField
        label="מעבר לדף אחרי שליחה (לא חובה)"
        name="redirect_url"
        dir="ltr"
        inputMode="url"
        autoComplete="off"
        placeholder="https://example.co.il/thanks"
        defaultValue={values?.redirect_url ?? intake.redirectUrl ?? ""}
        error={errors.redirect_url}
        hint="כשיש כתובת, עוברים אליה במקום הודעת התודה וכפתור ה-WhatsApp."
      />
    </fieldset>
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

/**
 * The form's public link, first on the sharing screen (FXU-11): most businesses
 * share it in WhatsApp, a post or an ad, and have no website to embed it in.
 */
export function ShareLink({ url, title }: { url: string; title: string }) {
  const [copied, setCopied] = useState(false);
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>קישור לשיתוף</Label>
      <Input id={id} value={url} readOnly dir="ltr" className="font-mono text-sm" onFocus={(event) => event.currentTarget.select()} />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              // clipboard blocked: the link is selectable in the field
              setCopied(false);
            }
          }}
        >
          {copied ? "הקישור הועתק" : "העתקת הקישור"}
        </Button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(`${title}\n${url}`)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonClasses("secondary", "sm")}
        >
          שליחה ב-WhatsApp
        </a>
        <a href={url} target="_blank" rel="noopener" className={buttonClasses("secondary", "sm")}>
          פתיחת הטופס
        </a>
      </div>
      <span aria-live="polite" className="sr-only">
        {copied ? "הקישור הועתק" : ""}
      </span>
    </div>
  );
}

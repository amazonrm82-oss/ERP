"use client";

import { useActionState, useEffect, useState } from "react";

import { Button, buttonClasses } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FormError } from "@/components/ui/feedback";
import { TextareaField, TextField } from "@/components/ui/field";
import { PhoneIcon } from "@/components/ui/icons";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { logCallAction } from "../actions";
import { CALL_OUTCOMES, NEXT_STEPS, type TimelineSubject } from "../schema";

type Props = { tel: string; orgId: string; subject: TimelineSubject; name: string };

/**
 * "חיוג" that also offers to log the call (TASK-02): the phone dials, and the
 * page opens a short window for how it ended, a note and the next step.
 */
export function CallLogButton({ tel, orgId, subject, name }: Props) {
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <>
      <a
        href={tel}
        className={buttonClasses("secondary", "sm")}
        onClick={() => {
          setSaved(false);
          // let the dialler open first; the window waits for the person to come back
          setTimeout(() => setOpen(true), 300);
        }}
      >
        <PhoneIcon className="size-4.5 text-accent" />
        חיוג
      </a>
      <Dialog open={open} onClose={() => setOpen(false)} title="תיעוד השיחה" description={`השיחה עם ${name}`} variant="sheet">
        {open ? (
          <CallLogForm
            orgId={orgId}
            subject={subject}
            name={name}
            onDone={(didSave) => {
              setOpen(false);
              setSaved(didSave);
            }}
          />
        ) : null}
      </Dialog>
      <span role="status" className="sr-only">
        {saved ? "השיחה נרשמה בציר הזמן." : ""}
      </span>
    </>
  );
}

function CallLogForm({ orgId, subject, name, onDone }: { orgId: string; subject: TimelineSubject; name: string; onDone: (saved: boolean) => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(logCallAction.bind(null, orgId, subject, name), null);
  const failure = state && !state.ok ? state : null;
  const [next, setNext] = useState("none");

  useEffect(() => {
    if (state?.ok) onDone(true);
  }, [state, onDone]);

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">איך הסתיימה השיחה</legend>
        <div className="grid grid-cols-2 gap-2">
          {CALL_OUTCOMES.map((option) => (
            <label key={option.value} className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name="outcome" value={option.value} defaultChecked={failure?.values?.outcome === option.value} required />
              {option.label}
            </label>
          ))}
        </div>
        {failure?.fieldErrors?.outcome ? <p className="mt-1 text-sm text-danger">{failure.fieldErrors.outcome}</p> : null}
      </fieldset>
      <TextareaField label="מה סוכם (לא חובה)" name="body" rows={3} maxLength={5000} defaultValue={failure?.values?.body ?? ""} error={failure?.fieldErrors?.body} />
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">הפעולה הבאה</legend>
        <div className="flex flex-wrap gap-2">
          {NEXT_STEPS.map((option) => (
            <label key={option.value} className="flex min-h-11 items-center gap-2 rounded-md border border-line px-3 has-checked:border-accent has-checked:bg-accent-soft">
              <input type="radio" name="next" value={option.value} checked={next === option.value} onChange={() => setNext(option.value)} />
              {option.value === "none" ? option.label : `משימה ל${option.label === "מחר" ? "מחר" : "עוד שבוע"}`}
            </label>
          ))}
        </div>
      </fieldset>
      {next !== "none" ? <TextField label="מה צריך לעשות" name="next_title" maxLength={300} placeholder={`לחזור אל ${name}`} error={failure?.fieldErrors?.next_title} /> : null}
      <div className="flex flex-wrap gap-2">
        <SubmitButton pendingText="שומרים…">שמירת השיחה</SubmitButton>
        <Button variant="ghost" onClick={() => onDone(false)}>
          לא עכשיו
        </Button>
      </div>
    </form>
  );
}

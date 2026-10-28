"use client";

import { useActionState, useState } from "react";

import { SelectField, TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { createQrCodeAction } from "../actions";
import { QR_KIND_LABELS, type QrTargetKind } from "../model";
import type { QrTargetOption } from "../queries";

const optionLabel = (option: QrTargetOption) => (option.active ? option.label : `${option.label} (כבוי)`);

const PICK_LABELS: Record<Exclude<QrTargetKind, "url">, string> = {
  form: "איזה טופס",
  booking: "איזה דף קביעת תור",
  card: "כרטיס הביקור של",
};

/**
 * BIZ-03: a new code: its name (the sign or flyer it goes on), the kind of target (a form, a booking page, a rep's
 * business card or a link) and the target itself.
 */
export function QrCodeForm({
  orgId,
  forms,
  pages,
  cards,
  externalOff = false,
}: {
  orgId: string;
  forms: QrTargetOption[];
  pages: QrTargetOption[];
  // active cards only: a code is not pointed at a card nobody can open
  cards: QrTargetOption[];
  // BIZ-03 (owner, 27 October 2026, answer (ג)): the platform has switched off the business's external links
  externalOff?: boolean;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(createQrCodeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const options: Record<Exclude<QrTargetKind, "url">, QrTargetOption[]> = { form: forms, booking: pages, card: cards };
  const kinds = (["form", "booking", "card", "url"] as const).filter((k) => (k === "url" ? !externalOff : options[k].length > 0));
  const firstKind = kinds[0];
  const sentKind = kinds.find((k) => k === values?.kind);
  const [kind, setKind] = useState<QrTargetKind | undefined>(sentKind ?? firstKind);

  if (!kind) {
    // nothing to open: links are switched off and the business has no form, booking page or open card yet
    return (
      <p role="status" className="text-md text-ink-soft">
        אין כרגע יעד לקוד: קישורים חיצוניים כובו על ידי צוות המערכת, ועוד אין לעסק טופס אתר, דף קביעת תור או כרטיס ביקור פעיל.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="שם הקוד"
        name="name"
        maxLength={80}
        required
        hint="למשל: שלט בחלון, פלייר בכנס. השם נשמר בליד כקמפיין, כך שרואים מאיזה קוד הגיע."
        defaultValue={values?.name ?? ""}
        error={failure?.fieldErrors?.name}
      />
      <SelectField
        label="מה הקוד פותח"
        name="kind"
        required
        value={kind}
        onChange={(event) => setKind(event.target.value as QrTargetKind)}
        error={failure?.fieldErrors?.kind}
        hint={externalOff ? "קישור לאתר חיצוני לא זמין: צוות המערכת כיבה את הקישורים החיצוניים של העסק." : undefined}
      >
        {kinds.map((k) => (
          <option key={k} value={k}>
            {QR_KIND_LABELS[k]}
          </option>
        ))}
      </SelectField>
      {kind === "url" ? (
        <TextField
          key="url"
          label="הקישור"
          name="url"
          type="url"
          dir="ltr"
          inputMode="url"
          maxLength={2000}
          required
          placeholder="https://"
          hint="כל כתובת שמתחילה ב-https://, למשל עמוד הביקורות שלכם בגוגל. הקוד מוסיף לקישור תיוג קמפיין (utm)."
          defaultValue={values?.kind === "url" ? (values?.url ?? "") : ""}
          error={failure?.fieldErrors?.url}
        />
      ) : (
        <SelectField
          key={kind}
          label={PICK_LABELS[kind]}
          name="target"
          required
          defaultValue={values?.kind === kind ? (values?.target ?? "") : ""}
          error={failure?.fieldErrors?.target}
        >
          <option value="" disabled>
            בחירה…
          </option>
          {options[kind].map((option) => (
            <option key={option.value} value={option.value}>
              {optionLabel(option)}
            </option>
          ))}
        </SelectField>
      )}
      <SubmitButton>יצירת הקוד</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}

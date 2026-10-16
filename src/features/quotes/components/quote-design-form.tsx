"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { DEFAULT_PICKER_COLOR } from "@/features/branding/color";
import type { FormState } from "@/lib/action-result";

import { saveQuoteDesignAction } from "../design-actions";
import { QUOTE_FOOTER_MAX, QUOTE_HEADER_MAX, type QuoteDesign } from "../design";

type Props = { orgId: string; design: QuoteDesign; brandColor: string | null };

/** QUO-05: the quote design form (owners and admins). */
export function QuoteDesignForm({ orgId, design, brandColor }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveQuoteDesignAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const [ownColor, setOwnColor] = useState(design.accentColor !== null);
  const [color, setColor] = useState(design.accentColor ?? brandColor ?? DEFAULT_PICKER_COLOR);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <FormGuard state={state} />
      <FormError message={failure?.fieldErrors ? undefined : failure?.message} />
      {state?.ok && state.message ? <FormNotice message={state.message} /> : null}
      <TextareaField
        label="כותרת עליונה"
        name="header_text"
        rows={2}
        maxLength={QUOTE_HEADER_MAX}
        defaultValue={failure?.values?.header_text ?? design.headerText ?? ""}
        hint="מופיעה מעל פרטי ההצעה. למשל משפט על העסק. רשות."
        error={errors.header_text}
      />
      <TextareaField
        label="כותרת תחתונה"
        name="footer_text"
        rows={3}
        maxLength={QUOTE_FOOTER_MAX}
        defaultValue={failure?.values?.footer_text ?? design.footerText ?? ""}
        hint="מופיעה בסוף ההצעה. למשל פרטי חשבון להעברה או תודה. רשות."
        error={errors.footer_text}
      />
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-medium">מה מופיע בראש ההצעה</legend>
        <Checkbox name="show_logo" label="הלוגו של העסק" defaultChecked={design.showLogo} hint="הלוגו נקבע ב&quot;פרטי העסק&quot;." />
        <Checkbox
          name="show_business_details"
          label="פרטי העסק"
          defaultChecked={design.showBusinessDetails}
          hint="השם הרשום, מספר העוסק, הכתובת, הטלפון והאימייל, כפי שנקבעו ב&quot;מע&quot;מ ופרטים למסמכים&quot;."
        />
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-medium">צבע</legend>
        <div className="space-y-2">
          <label className="flex items-center gap-3">
            <input type="radio" name="color_mode" value="brand" checked={!ownColor} onChange={() => setOwnColor(false)} className="size-4" />
            <span>{brandColor ? "הצבע של העסק" : "הצבע הרגיל (לעסק עוד אין צבע משלו)"}</span>
          </label>
          <label className="flex items-center gap-3">
            <input type="radio" name="color_mode" value="own" checked={ownColor} onChange={() => setOwnColor(true)} className="size-4" />
            <span>צבע אחר להצעות</span>
          </label>
        </div>
        {ownColor ? (
          <div className="flex flex-wrap items-end gap-3">
            <input
              type="color"
              aria-label="בחירת צבע"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="h-11 w-14 cursor-pointer rounded-md border border-line-control bg-surface"
            />
            <TextField
              label="קוד הצבע"
              name="accent_color"
              dir="ltr"
              value={color}
              onChange={(event) => setColor(event.target.value)}
              error={errors.accent_color}
              className="max-w-40"
            />
          </div>
        ) : null}
        <p className="text-sm text-ink-soft">הגוון מותאם אוטומטית כך שהטקסט יהיה קריא.</p>
      </fieldset>
      <SubmitButton pendingText="שומרים…">שמירה</SubmitButton>
    </form>
  );
}

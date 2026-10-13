"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { TemplatePreviewList } from "@/features/industry-templates/components/template-preview";
import { industryTemplate, type TemplatePreview } from "@/features/industry-templates/templates";
import { INDUSTRIES } from "@/features/onboarding/options";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { saveSetupIndustryAction } from "../actions";

type Props = {
  orgId: string;
  industry: string | null;
  // FLD-05: what each industry's template would add now, by industry key
  previews: Record<string, TemplatePreview>;
};

/**
 * Step 2: the industry of the business (the same list as the sign-up form and
 * the business details page), and its template: a preview of what it adds,
 * then "apply and continue" or "continue without it".
 */
export function IndustryStepForm({ orgId, industry, previews }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveSetupIndustryAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const [chosen, setChosen] = useState(failure?.values?.industry ?? industry ?? "");
  const template = industryTemplate(chosen);
  const preview = template ? previews[template.industry] : undefined;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      {/* Enter in the form submits its first submit button: this one, which never applies the template.
          Out of reach for keyboard and screen readers, so the visible buttons keep one order for sight and focus. */}
      <button type="submit" name="apply" value="0" tabIndex={-1} aria-hidden="true" className="sr-only">
        המשך בלי התבנית
      </button>
      <SelectField
        label="ענף"
        name="industry"
        hint="אפשר לשנות אחר כך בפרטי העסק."
        value={chosen}
        onChange={(event) => setChosen(event.target.value)}
        error={failure?.fieldErrors?.industry}
      >
        <option value="">לא נבחר</option>
        {INDUSTRIES.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SelectField>
      {template && preview ? (
        <section aria-labelledby="setup-template-title" className="rounded-md border border-line p-3">
          <h3 id="setup-template-title" className="font-semibold">
            {`תבנית ענף: ${template.title}`}
          </h3>
          <p className="mt-1 mb-3 text-sm text-ink-soft">אלה יתווספו לרשימות שלכם. שום דבר קיים לא נמחק, ואפשר לשנות הכול אחר כך.</p>
          <TemplatePreviewList preview={preview} headingId="setup-template-title" />
        </section>
      ) : null}
      <FormError message={failure?.message} />
      <FormNotice message={state?.ok ? state.message : null} />
      {state?.ok ? (
        <Link href={paths.setup(orgId, 3)} className="inline-block min-h-11 content-center text-md text-accent-strong underline underline-offset-4">
          לשלב הבא
        </Link>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {template ? (
          <SubmitButton name="apply" value="1" pendingText="מחילים…">
            החלת התבנית והמשך
          </SubmitButton>
        ) : null}
        <SubmitButton name="apply" value="0" variant={template ? "secondary" : "primary"}>
          {template ? "המשך בלי התבנית" : "שמירה והמשך"}
        </SubmitButton>
      </div>
    </form>
  );
}

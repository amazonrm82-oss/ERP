"use client";

import { useActionState, useState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { applyIndustryTemplateAction } from "../actions";
import { INDUSTRY_TEMPLATES, industryTemplate, type TemplatePreview } from "../templates";
import { TemplatePreviewList } from "./template-preview";

type Props = {
  orgId: string;
  // the organization's industry: the template offered first
  industry: string | null;
  previews: Record<string, TemplatePreview>;
  applied: string[];
};

/** Business details page (FLD-05): add an industry template's lists at any time. */
export function IndustryTemplateCard({ orgId, industry, previews, applied }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(applyIndustryTemplateAction.bind(null, orgId), null);
  const [chosen, setChosen] = useState(industryTemplate(industry)?.industry ?? INDUSTRY_TEMPLATES[0].industry);
  const preview = previews[chosen];
  const appliedTitles = applied.map((key) => industryTemplate(key)?.title).filter((t): t is string => Boolean(t));

  return (
    <Card aria-labelledby="industry-template-title">
      <CardHeader id="industry-template-title" title="תבנית ענף" />
      <CardBody>
        <p className="mb-4 text-md text-ink-soft">
          תבנית מוסיפה לעסק תהליך מכירה, סטטוסים, מקורות, שדות ואוטומציות שמתאימים לענף. היא לא מוחקת ולא משנה שום דבר קיים, ואפשר לשנות כל מה שנוסף.
        </p>
        {appliedTitles.length > 0 ? <p className="mb-4 text-sm text-ink-soft">{`תבניות שכבר הוחלו: ${appliedTitles.join(", ")}.`}</p> : null}
        <form action={formAction} className="space-y-4" noValidate>
          <SelectField
            label="תבנית"
            name="template"
            value={chosen}
            onChange={(event) => setChosen(event.target.value)}
            error={state && !state.ok ? state.fieldErrors?.template : undefined}
          >
            {INDUSTRY_TEMPLATES.map((t) => (
              <option key={t.industry} value={t.industry}>
                {t.title}
              </option>
            ))}
          </SelectField>
          <section aria-labelledby="industry-template-preview" className="rounded-md border border-line p-3">
            <h3 id="industry-template-preview" className="mb-2 font-semibold">
              מה יתווסף
            </h3>
            {preview ? <TemplatePreviewList preview={preview} headingId="industry-template-preview" /> : null}
          </section>
          <FormError message={state && !state.ok ? state.message : null} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton pendingText="מחילים…">החלת התבנית</SubmitButton>
        </form>
      </CardBody>
    </Card>
  );
}

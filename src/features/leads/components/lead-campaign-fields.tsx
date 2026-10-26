import { TextField } from "@/components/ui/field";

import { LEAD_CAMPAIGN_FIELD_NAMES, LEAD_UTM_KEYS, type LeadUtmKey } from "../schema";

// LEAD-01: what each UTM value is called on the lead form (the technical key stays visible,
// because that is how the ad platforms and the landing page name it)
export const UTM_LABELS: Record<LeadUtmKey, string> = {
  utm_source: "מקור (utm_source)",
  utm_medium: "ערוץ (utm_medium)",
  utm_campaign: "קמפיין ב-UTM (utm_campaign)",
  utm_term: "מילת חיפוש (utm_term)",
  utm_content: "מודעה (utm_content)",
};

type Props = {
  // starting values as typed in the form (budget in shekels)
  values: Partial<Record<(typeof LEAD_CAMPAIGN_FIELD_NAMES)[number], string>>;
  errors: Record<string, string>;
  // the visit's page addresses and ad ids are shown on the card and cannot be edited
  readOnlyNote?: boolean;
  // DQL-04: the set parts of the lead's first source this user may not change (shown read-only, sent unchanged)
  locked?: { campaign: boolean; utm: string[] } | null;
};

const LOCKED_HINT = "נעול: חלק מהמקור הראשון.";

/** Campaign, budget and the five UTM values of a lead, folded away until needed. */
export function LeadCampaignFields({ values, errors, readOnlyNote, locked = null }: Props) {
  const hasValue = LEAD_CAMPAIGN_FIELD_NAMES.some((name) => (values[name] ?? "") !== "");
  const hasError = LEAD_CAMPAIGN_FIELD_NAMES.some((name) => Boolean(errors[name]));

  return (
    <details className="rounded-lg border border-line bg-surface" open={hasValue || hasError}>
      <summary className="flex min-h-11 cursor-pointer items-center px-4 text-md font-medium">קמפיין ותקציב</summary>
      <div className="space-y-4 border-t border-line px-4 py-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="קמפיין"
            name="campaign"
            maxLength={200}
            autoComplete="off"
            defaultValue={values.campaign ?? ""}
            readOnly={locked?.campaign}
            hint={locked?.campaign ? LOCKED_HINT : undefined}
            error={errors.campaign}
          />
          <TextField
            label="תקציב (₪)"
            name="budget"
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
            hint="בשקלים, למשל 12,500."
            defaultValue={values.budget ?? ""}
            error={errors.budget}
          />
        </div>
        <fieldset className="space-y-4">
          <legend className="mb-3 text-sm text-ink-soft">פרמטרי UTM</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            {LEAD_UTM_KEYS.map((key) => (
              <TextField
                key={key}
                label={UTM_LABELS[key]}
                name={key}
                dir="auto"
                autoComplete="off"
                defaultValue={values[key] ?? ""}
                readOnly={locked?.utm.includes(key)}
                hint={locked?.utm.includes(key) ? LOCKED_HINT : undefined}
                error={errors[key]}
              />
            ))}
          </div>
        </fieldset>
        {readOnlyNote ? (
          <p className="text-sm text-ink-soft">כתובות הדפים ומזהי הפרסום נשמרים מהביקור ואי אפשר לערוך אותם.</p>
        ) : null}
      </div>
    </details>
  );
}

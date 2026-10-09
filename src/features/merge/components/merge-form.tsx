"use client";

import { useActionState } from "react";

import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { mergeRecordsAction } from "../actions";
import { MERGE_FIELDS, type MergeType } from "../fields";

type Side = { id: string; title: string; values: Record<string, string | null> };
type Props = { orgId: string; type: MergeType; keep: Side; dup: Side };

/** One row per field: which value stays. Only fields that differ are asked about. */
export function MergeForm({ orgId, type, keep, dup }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(mergeRecordsAction.bind(null, orgId, type, keep.id, dup.id), null);
  const failure = state && !state.ok ? state : null;
  const differing = MERGE_FIELDS[type].filter(({ key }) => dup.values[key] !== null && dup.values[key] !== keep.values[key]);
  const same = MERGE_FIELDS[type].filter(({ key }) => !differing.some((d) => d.key === key) && keep.values[key] !== null);

  return (
    <form action={formAction} className="space-y-5">
      <FormError message={failure?.message} />
      {differing.length === 0 ? (
        <p className="text-md">אין שדות שונים. כל הפרטים של {keep.title} נשארים.</p>
      ) : (
        <fieldset className="space-y-3">
          <legend className="mb-1 font-semibold">באילו ערכים להשתמש?</legend>
          {differing.map(({ key, label }) => (
            <div key={key} role="radiogroup" aria-label={label} className="rounded-lg border border-line p-3">
              <p className="mb-2 text-sm font-medium text-ink-soft">{label}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {(["keep", "merge"] as const).map((choice) => {
                  const value = choice === "keep" ? keep.values[key] : dup.values[key];
                  // an empty field on the kept record takes the duplicate's value by default
                  const checked = choice === "merge" ? keep.values[key] === null : keep.values[key] !== null;
                  return (
                    <label key={choice} className="flex min-h-11 cursor-pointer items-start gap-2 rounded-md border border-line px-3 py-2 has-checked:border-accent has-checked:bg-accent-soft">
                      <input type="radio" name={key} value={choice} defaultChecked={checked} className="mt-1 size-4 shrink-0" />
                      <span className="min-w-0 break-words">
                        <span className={value ? undefined : "text-ink-soft"}>{value ? <bdi>{value}</bdi> : "(ריק)"}</span>
                        <span className="block text-xs text-ink-soft">מתוך {choice === "keep" ? keep.title : dup.title}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </fieldset>
      )}
      {same.length > 0 ? (
        <p className="text-sm text-ink-soft">
          זהים או קיימים רק ברשומה שנשארת: {same.map((f) => f.label).join(", ")}.
        </p>
      ) : null}
      <div className="rounded-lg bg-canvas p-3 text-md">
        <p>
          הרשומה <strong>{keep.title}</strong> נשארת. ההערות, המשימות, הקבצים, התגיות והעסקאות של <strong>{dup.title}</strong> עוברים אליה, והרשומה {dup.title} נמחקת.
        </p>
        <p className="mt-1 text-sm text-ink-soft">אי אפשר לבטל מיזוג. כל הפרטים של הרשומה שנמחקת נשמרים ביומן הביקורת.</p>
      </div>
      {/* FXU-07: it cannot be undone, so it looks like it */}
      <SubmitButton variant="danger" pendingText="ממזגים…">
        מיזוג הרשומות
      </SubmitButton>
    </form>
  );
}

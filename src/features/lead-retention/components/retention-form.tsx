"use client";

import { useActionState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { disableRetentionAction, enableRetentionAction, previewRetentionAction } from "../actions";
import { previewText, RETENTION_MONTHS_DEFAULT, RETENTION_MONTHS_MAX, RETENTION_MONTHS_MIN } from "../model";
import type { RetentionPreview } from "../schema";

type Words = { singular: string; plural: string; oneWord: string };
type Props = { orgId: string; enabled: boolean; months: number | null; words: Words };

/**
 * PRV-01: turning the policy on, or changing its months, is two steps: "בדיקה" shows how many leads it would take, then a
 * confirmation window turns it on. Turning it off is one confirmation. Owners and admins of a writable business.
 */
export function RetentionForm({ orgId, enabled, months, words }: Props) {
  const [state, formAction] = useActionState<FormState<RetentionPreview>, FormData>(previewRetentionAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const preview = state?.ok ? state.data : undefined;
  const unchanged = enabled && preview?.months === months;

  return (
    <div className="space-y-4">
      <form action={formAction} noValidate className="space-y-4">
        <TextField
          label="חודשים בלי קשר עד המעבר לסל המחזור"
          name="months"
          type="number"
          inputMode="numeric"
          min={RETENTION_MONTHS_MIN}
          max={RETENTION_MONTHS_MAX}
          step={1}
          dir="ltr"
          className="max-w-40"
          hint={`לפחות ${RETENTION_MONTHS_MIN} חודשים.`}
          defaultValue={failure?.values?.months ?? String(months ?? RETENTION_MONTHS_DEFAULT)}
          error={failure?.fieldErrors?.months}
        />
        <FormError message={failure?.fieldErrors?.months ? null : failure?.message} />
        <SubmitButton variant="secondary" pendingText="בודקים…">{enabled ? "בדיקה לפני שינוי" : "בדיקה לפני הפעלה"}</SubmitButton>
      </form>

      {preview ? (
        <div className="space-y-3 rounded-md border border-line p-3" role="status">
          <p className="text-sm">{previewText(preview, words)}</p>
          {unchanged ? (
            <p className="text-sm text-ink-soft">זה מספר החודשים שכבר מוגדר.</p>
          ) : (
            <ConfirmButton
              variant="primary"
              size="md"
              title={enabled ? `לשנות ל-${preview.months} חודשים?` : `להפעיל את המדיניות, ${preview.months} חודשים?`}
              description={`${previewText(preview, words)}${enabled ? " הרשימה הפתוחה מתבטלת, ורשימה חדשה תישלח." : ""}`}
              confirmLabel={enabled ? "שינוי" : "הפעלה"}
              action={enableRetentionAction.bind(null, orgId, preview.months)}
            >
              {enabled ? "שינוי מספר החודשים" : "הפעלת המדיניות"}
            </ConfirmButton>
          )}
        </div>
      ) : null}

      {enabled ? (
        <ConfirmButton
          title="לכבות את מדיניות השמירה?"
          description="הרשימה הפתוחה מתבטלת והמדיניות מפסיקה להעביר לסל המחזור. מה שכבר בסל נשאר שם, ואפשר לשחזר אותו עד שיימחק."
          confirmLabel="כיבוי"
          action={disableRetentionAction.bind(null, orgId)}
        >
          כיבוי המדיניות
        </ConfirmButton>
      ) : null}
    </div>
  );
}

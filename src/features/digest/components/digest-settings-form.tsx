"use client";

import { useActionState, useState } from "react";

import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, SelectField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { submitWith } from "@/lib/use-submit";

import { saveDigestSettingsAction } from "../actions";
import { DIGEST_TIMES, type DigestKind, type DigestSettings } from "../settings";

/**
 * USR-11 / WAB-03: the person's own daily summary email, per business. Owners, admins and managers get the business lines
 * (new leads, waiting leads, overdue tasks, money waiting); everyone else their own.
 */
export function DigestSettingsForm({
  orgId,
  settings,
  kind,
  inPlan,
  stoppedText,
}: {
  orgId: string;
  settings: DigestSettings;
  kind: DigestKind;
  /** owner (376) ב: every plan but the free plan */
  inPlan: boolean;
  /** when the person stopped it from the email's link, as the business shows dates (null = not stopped that way) */
  stoppedText: string | null;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(saveDigestSettingsAction.bind(null, orgId), null);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [sendAt, setSendAt] = useState(settings.sendAt);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <form onSubmit={submitWith(formAction)} className="space-y-4">
      <FormError message={state && !state.ok ? state.message : null} />
      <FormNotice message={state?.ok ? state.message : null} />
      <Checkbox
        name="digest_enabled"
        label="סיכום יומי במייל"
        hint={
          kind === "manager"
            ? "בכל בוקר של יום עבודה: לידים חדשים, לידים שמחכים, משימות באיחור וכסף שמחכה בעסק. מספרים בלבד, בלי שמות לקוחות."
            : "בכל בוקר של יום עבודה: הלידים שלכם שמחכים והמשימות שלכם. מספרים בלבד, בלי שמות לקוחות."
        }
        checked={enabled}
        onChange={(e) => setEnabled(e.target.checked)}
      />
      {enabled ? (
        <SelectField
          label="שעת השליחה (לפי שעון העסק)"
          name="digest_send_at"
          value={sendAt}
          onChange={(e) => setSendAt(e.target.value)}
          controlSize="sm"
          className="w-36"
          error={errors.digest_send_at}
        >
          {DIGEST_TIMES.map((time) => (
            <option key={time} value={time} dir="ltr">
              {time}
            </option>
          ))}
        </SelectField>
      ) : (
        <input type="hidden" name="digest_send_at" value={sendAt} />
      )}
      {stoppedText && !enabled ? (
        <p className="text-sm text-ink-soft">הסיכום הופסק מהקישור במייל ב-{stoppedText}. אפשר להפעיל אותו מחדש כאן.</p>
      ) : null}
      {inPlan ? null : (
        <p className="text-sm text-ink-soft">הסיכום היומי לא כלול בחבילה הנוכחית. הבחירה נשמרת, והסיכום יישלח כשהחבילה תכלול אותו.</p>
      )}
      <p className="text-sm text-ink-soft">
        בימי מנוחה של העסק ובזמן חופשה לא נשלח סיכום. בשעות השקט שלכם הסיכום מחכה לסופן. בכל מייל יש קישור להפסקה בלחיצה אחת.
      </p>
      <SubmitButton pendingText="שומרים…" pending={pending}>
        שמירה
      </SubmitButton>
    </form>
  );
}

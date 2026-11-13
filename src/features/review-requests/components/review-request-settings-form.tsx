"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { Checkbox, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveReviewRequestSettingsAction } from "../actions";
import { REVIEW_DELAY_MAX, type ReviewRequestSettings } from "../review-url";

// dealWonLabel: the "won deal" choice in the business's words (reviewDealWonLabel, read on the server; RVW-94)
type Props = { orgId: string; settings: ReviewRequestSettings; inPlan: boolean; dealWonLabel: string };

/** RET-02: the business's review requests. Owners and admins of a writable business. */
export function ReviewRequestSettingsForm({ orgId, settings, inPlan, dealWonLabel }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveReviewRequestSettingsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const values = failure?.values;
  const checked = (name: string, stored: boolean) => (values ? values[name] === "on" : stored);

  return (
    <form action={formAction} noValidate>
      <Card aria-labelledby="review-requests-title">
        <CardHeader id="review-requests-title" title="בקשת ביקורת מלקוחות" />
        <CardBody className="space-y-5">
          <Checkbox
            name="enabled"
            label="לשלוח בקשת ביקורת"
            defaultChecked={checked("enabled", settings.enabled)}
            disabled={!inPlan && !settings.enabled}
            hint={inPlan ? "ההודעה נשלחת רק ללקוחות שהסכימו לקבל הודעות שיווקיות בערוץ הזה." : "בקשת ביקורת לא כלולה בחבילה של העסק."}
          />
          <TextField
            label="הקישור לדף הביקורות"
            name="review_url"
            type="url"
            inputMode="url"
            dir="ltr"
            autoComplete="off"
            placeholder="https://g.page/r/…/review"
            hint={'קישור לדף שבו כותבים ביקורת על העסק: ב-Google, בפייסבוק, ב-easy, בזאפ או בכל אתר אחר, שמתחיל ב-https://. ב-Google: בפרופיל העסק לוחצים על "קבלת ביקורות" ומעתיקים את הקישור.'}
            defaultValue={values?.review_url ?? settings.reviewUrl ?? ""}
            error={errors.review_url}
          />
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-ink">מתי לשלוח</legend>
            <Checkbox name="on_deal_won" label={dealWonLabel} defaultChecked={checked("on_deal_won", settings.onDealWon)} />
            <Checkbox name="on_meeting_held" label="אחרי פגישה שהתקיימה" defaultChecked={checked("on_meeting_held", settings.onMeetingHeld)} />
            {errors.on_deal_won ? <p className="text-sm text-danger">{errors.on_deal_won}</p> : null}
          </fieldset>
          <TextField
            label="כמה ימים אחרי לשלוח"
            name="delay_days"
            type="number"
            inputMode="numeric"
            min={0}
            max={REVIEW_DELAY_MAX}
            step={1}
            dir="ltr"
            className="max-w-40"
            hint={`בין 0 ל-${REVIEW_DELAY_MAX}. 0 = באותו יום.`}
            defaultValue={values?.delay_days ?? String(settings.delayDays)}
            error={errors.delay_days}
          />
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>
    </form>
  );
}

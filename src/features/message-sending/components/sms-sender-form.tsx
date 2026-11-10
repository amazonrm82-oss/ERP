"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { SMS_SENDER_NAME_HELP, SMS_SENDER_PENDING, SMS_SENDER_REJECTED, type SmsSender } from "@/features/messaging/sms-sender";
import type { FormState } from "@/lib/action-result";

import { saveSmsSenderAction, startSenderCheckAction, verifySenderCodeAction } from "../actions";

type Props = { orgId: string; sender: SmsSender };

/** What the customer's phone shows now (SMS-01b: an approved name, else the verified number, else the platform default). */
export function smsSenderNowText(sender: SmsSender): string {
  if (sender.effective) return `ההודעות יוצאות כרגע בשם ${sender.effective}.`;
  return "ההודעות יוצאות כרגע בשם השולח הכללי של המערכת.";
}

/**
 * SMS-01 / SMS-01b (owner (211) א): the name the customer's phone shows as the sender. A letter name waits for the provider's
 * approval; a number is only the business's own phone, verified once by a code sent to it. Owners and admins of a writable
 * business.
 */
export function SmsSenderForm({ orgId, sender }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveSmsSenderAction.bind(null, orgId), null);
  const [startState, startAction] = useActionState<FormState, FormData>(() => startSenderCheckAction(orgId), null);
  const [verifyState, verifyAction] = useActionState<FormState, FormData>(verifySenderCodeAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  const verifyFailure = verifyState && !verifyState.ok ? verifyState : null;

  return (
    <Card aria-labelledby="sms-sender-title">
      <CardHeader id="sms-sender-title" title="שם השולח ב-SMS" />
      <CardBody className="space-y-5">
        <p className="text-sm text-ink-soft">
          זה מה שהלקוח רואה כשולח ההודעה. שם באותיות נשלח לאישור ספק ה-SMS, ועד שהוא מאושר ההודעות יוצאות ממספר הטלפון של העסק (אחרי אימות), או בשם הכללי
          של המערכת. ספק ה-SMS עוד לא חובר, ולכן הודעות SMS ממתינות בתור.
        </p>
        <p className="text-sm">
          {smsSenderNowText(sender)}
          {sender.nameState === "pending" ? ` השם ${sender.name}: ${SMS_SENDER_PENDING}.` : null}
          {sender.nameState === "rejected" ? ` ${SMS_SENDER_REJECTED}: ${sender.name}. אפשר לבחור שם אחר.` : null}
        </p>
        <form action={formAction} noValidate className="space-y-5">
          <TextField
            label="שם השולח"
            name="sms_sender_name"
            dir="ltr"
            maxLength={16}
            autoComplete="off"
            className="max-w-sm"
            hint={SMS_SENDER_NAME_HELP}
            defaultValue={failure?.values?.sms_sender_name ?? sender.name ?? ""}
            error={errors.sms_sender_name}
          />
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </form>
        <div className="space-y-3 border-t border-line pt-4">
          <h3 className="text-md font-semibold">אימות מספר הטלפון של העסק</h3>
          {sender.verifiedPhone ? (
            <p className="text-sm">
              המספר <span dir="ltr">{sender.verifiedPhone}</span> אומת.
            </p>
          ) : (
            <p className="text-sm text-ink-soft">
              כדי שהודעות ייצאו ממספר הטלפון של העסק{sender.businessPhone ? <> (<span dir="ltr">{sender.businessPhone}</span>)</> : null}, שולחים אליו קוד
              ומקלידים אותו כאן. הקוד בתוקף עשר דקות, ואחרי חמישה ניסיונות שגויים מחכים חצי שעה.
            </p>
          )}
          <form action={startAction}>
            <SubmitButton variant="secondary">{sender.verifiedPhone ? "אימות מחדש" : "שליחת קוד"}</SubmitButton>
          </form>
          <FormError message={startState && !startState.ok ? startState.message : null} />
          <FormNotice message={startState?.ok ? startState.message : null} />
          <form action={verifyAction} noValidate className="flex flex-wrap items-end gap-3">
            <TextField
              label="הקוד שהתקבל"
              name="code"
              dir="ltr"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="sm:max-w-xs"
              error={verifyFailure?.fieldErrors?.code}
            />
            <SubmitButton>אימות</SubmitButton>
          </form>
          <FormError message={verifyFailure && !verifyFailure.fieldErrors?.code ? verifyFailure.message : null} />
          <FormNotice message={verifyState?.ok ? verifyState.message : null} />
        </div>
      </CardBody>
    </Card>
  );
}

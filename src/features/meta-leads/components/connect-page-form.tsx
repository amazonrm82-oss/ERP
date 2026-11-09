"use client";

import { useActionState } from "react";

import { TextField } from "@/components/ui/field";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { connectPageAction, replaceTokenAction } from "../actions";

/**
 * CAP-11: connects a Facebook page (its id, a name and the page's access token). The token field is never filled back
 * in: after saving it is encrypted on the server and not shown again. Until Meta approves the app, the token is pasted by
 * hand; the "connect with Facebook" button comes with the real provider.
 */
export function ConnectPageForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(connectPageAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const errors = failure?.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="שם הדף (רק בשבילכם)" name="name" maxLength={120} required defaultValue={failure?.values?.name ?? ""} error={errors.name} />
        <TextField
          label="מזהה הדף בפייסבוק"
          name="page_id"
          inputMode="numeric"
          dir="ltr"
          maxLength={40}
          required
          defaultValue={failure?.values?.page_id ?? ""}
          error={errors.page_id}
          hint="מספר שמופיע בהגדרות הדף, תחת 'פרטי הדף'."
        />
      </div>
      <TextField
        label="טוקן הגישה של הדף"
        name="token"
        type="password"
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        maxLength={4000}
        required
        error={errors.token}
        hint="הטוקן נשמר מוצפן ולא מוצג שוב, גם לא לכם."
      />
      <SubmitButton>חיבור הדף</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}

/** CAP-11: a new token for a connected page (an expired or revoked one). */
export function ReplaceTokenForm({ orgId, integrationId }: { orgId: string; integrationId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(replaceTokenAction.bind(null, orgId, integrationId), null);
  const failure = state && !state.ok ? state : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormError message={failure && !failure.fieldErrors ? failure.message : null} />
      <TextField
        label="טוקן חדש לדף"
        name="token"
        type="password"
        dir="ltr"
        autoComplete="off"
        spellCheck={false}
        maxLength={4000}
        required
        error={failure?.fieldErrors?.token}
        hint="מחליף את הטוקן השמור. הטוקן הקודם לא נשמר בשום מקום."
      />
      <SubmitButton variant="secondary">החלפת הטוקן</SubmitButton>
      <FormNotice message={state?.ok ? (state.message ?? null) : null} />
    </form>
  );
}

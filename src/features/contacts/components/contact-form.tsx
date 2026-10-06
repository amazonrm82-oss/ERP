"use client";

import { useActionState } from "react";

import { ButtonLink } from "@/components/ui/button";
import { FormError } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { createContactAction } from "../actions";

/** New contact form. On success the action redirects to the contact's page. */
export function ContactForm({ orgId }: { orgId: string }) {
  const [state, formAction] = useActionState<FormState, FormData>(createContactAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values ?? {};
  const errors = failure?.fieldErrors ?? {};

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormError message={failure?.message} />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="שם פרטי"
          name="first_name"
          autoComplete="off"
          maxLength={100}
          defaultValue={values.first_name}
          error={errors.first_name}
        />
        <TextField
          label="שם משפחה"
          name="last_name"
          autoComplete="off"
          maxLength={100}
          defaultValue={values.last_name}
          error={errors.last_name}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="טלפון"
          name="phone"
          type="tel"
          dir="ltr"
          inputMode="tel"
          autoComplete="off"
          defaultValue={values.phone}
          error={errors.phone}
        />
        <TextField
          label="אימייל"
          name="email"
          type="email"
          dir="ltr"
          inputMode="email"
          autoComplete="off"
          defaultValue={values.email}
          error={errors.email}
        />
      </div>
      <TextField
        label="תפקיד"
        name="job_title"
        autoComplete="off"
        maxLength={120}
        defaultValue={values.job_title}
        error={errors.job_title}
      />
      <p className="text-sm text-ink-soft">חובה למלא לפחות אחד: שם, טלפון או אימייל.</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <SubmitButton pendingText="יוצר איש קשר…">יצירת איש קשר</SubmitButton>
        <ButtonLink href={paths.contacts(orgId)} variant="ghost">
          ביטול
        </ButtonLink>
      </div>
    </form>
  );
}

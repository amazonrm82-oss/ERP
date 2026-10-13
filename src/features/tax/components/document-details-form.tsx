"use client";

import { useActionState } from "react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";

import { saveDocumentDetailsAction } from "../actions";
import type { DocumentDetails } from "../settings";

type Props = { orgId: string; details: DocumentDetails };

/** The business as quotes and payment requests show it (TAX-02). Owners and admins; others see a read-only view. */
export function DocumentDetailsForm({ orgId, details }: Props) {
  const [state, formAction] = useActionState<FormState, FormData>(saveDocumentDetailsAction.bind(null, orgId), null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const value = (name: string, saved: string | null) => values?.[name] ?? saved ?? "";

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <Card aria-labelledby="doc-details-title">
        <CardHeader id="doc-details-title" title="פרטי העסק במסמכים" />
        <CardBody className="space-y-4">
          <p className="text-sm text-ink-soft">מופיעים בהצעות מחיר ובדרישות תשלום. אפשר למלא עכשיו או מאוחר יותר.</p>
          <TextField
            label="שם רשמי"
            name="legal_name"
            autoComplete="organization"
            maxLength={120}
            hint='השם הרשום אצל רשם החברות או במע"מ.'
            defaultValue={value("legal_name", details.legalName)}
            error={errors.legal_name}
          />
          <TextField
            label="מספר עוסק או ח.פ."
            name="tax_id"
            dir="ltr"
            inputMode="numeric"
            maxLength={30}
            hint="9 ספרות. נבדקת ספרת הביקורת."
            defaultValue={value("tax_id", details.taxId)}
            error={errors.tax_id}
          />
          <TextField
            label="כתובת"
            name="address_line"
            autoComplete="street-address"
            maxLength={200}
            defaultValue={value("address_line", details.addressLine)}
            error={errors.address_line}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="יישוב"
              name="city"
              autoComplete="address-level2"
              maxLength={100}
              defaultValue={value("city", details.city)}
              error={errors.city}
            />
            <TextField
              label="מיקוד"
              name="postal_code"
              dir="ltr"
              inputMode="numeric"
              autoComplete="postal-code"
              maxLength={12}
              defaultValue={value("postal_code", details.postalCode)}
              error={errors.postal_code}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="טלפון למסמכים"
              name="phone"
              type="tel"
              dir="ltr"
              inputMode="tel"
              autoComplete="tel"
              defaultValue={value("phone", details.phone)}
              error={errors.phone}
            />
            <TextField
              label="אימייל למסמכים"
              name="email"
              type="email"
              dir="ltr"
              autoComplete="email"
              maxLength={254}
              hint="משמש גם בהזמנות ליומן. שינוי חל על הזמנות חדשות בלבד."
              defaultValue={value("email", details.email)}
              error={errors.email}
            />
          </div>
          <FormError message={failure?.message} />
          <FormNotice message={state?.ok ? state.message : null} />
          <SubmitButton>שמירה</SubmitButton>
        </CardBody>
      </Card>

    </form>
  );
}

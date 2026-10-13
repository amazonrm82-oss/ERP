"use client";

import Link from "next/link";
import { useActionState, useState, type ReactNode } from "react";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { PriceListStatusBadge } from "@/features/price-lists/components/price-list-status";
import { priceListApplies } from "@/features/price-lists/status";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { updateBillingAction } from "../actions";
import { effectiveBilling, type ShownValue } from "../billing";
import type { RecordBilling } from "../queries";
import { paymentTermsText } from "../terms";
import { BillingFields, billingFormValues } from "./billing-fields";

type Props = {
  orgId: string;
  recordId: string;
  billing: RecordBilling;
  canEdit: boolean;
  // the organization's today ("YYYY-MM-DD"), for the price list's validity
  today: string;
  // companies: the company's number (ח.פ.) is shown here from its details
  companyIsIsraeli?: boolean;
};

/** CON-08: the billing details of a company or contact, edited in place. */
export function BillingCard({ orgId, recordId, billing, canEdit, today, companyIsIsraeli = true }: Props) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <BillingEditForm orgId={orgId} recordId={recordId} billing={billing} onDone={() => setEditing(false)} />;
  }

  const shown = effectiveBilling(billing.own, billing.company?.billing ?? null);
  const fromCompany = (value: ShownValue<unknown>, content: ReactNode): ReactNode =>
    content === null || content === undefined || content === "" ? null : value.fromCompany ? (
      <span>
        {content} <span className="text-sm text-ink-soft">(מהחברה)</span>
      </span>
    ) : (
      content
    );
  const ltr = (text: string | null) => (text ? <span dir="ltr">{text}</span> : null);
  const list = shown.priceListId.value ? billing.priceLists.find((item) => item.id === shown.priceListId.value) : null;
  const taxLabel = billing.subject === "company" ? (companyIsIsraeli ? "ח.פ." : "מספר רישום") : 'מספר עוסק או ת"ז';

  return (
    <Card aria-labelledby="billing-title">
      <CardHeader
        id="billing-title"
        title="פרטי חיוב"
        action={
          canEdit ? (
            <Button variant="ghost" size="sm" aria-label="עריכת פרטי חיוב" onClick={() => setEditing(true)}>
              עריכה
            </Button>
          ) : null
        }
      />
      <CardBody className="space-y-3">
        <DetailList>
          <Detail label="שם לחשבונית" value={fromCompany(shown.name, shown.name.value)} />
          <Detail label={taxLabel} value={fromCompany(shown.taxId, ltr(shown.taxId.value))} />
          <Detail label="כתובת לחיוב" value={fromCompany(shown.address, shown.address.value)} />
          <Detail label="כתובת למשלוח" value={fromCompany(shown.shippingAddress, shown.shippingAddress.value)} />
          <Detail label="אימייל לחשבוניות" value={fromCompany(shown.email, ltr(shown.email.value))} />
          <Detail label="תנאי תשלום" value={fromCompany(shown.terms, paymentTermsText(shown.terms.value))} />
          <Detail
            label="מחירון"
            value={fromCompany(
              shown.priceListId,
              list ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <bdi>{list.name}</bdi>
                  {priceListApplies(list, today) ? null : <PriceListStatusBadge list={list} today={today} />}
                </span>
              ) : null,
            )}
          />
        </DetailList>
        {billing.subject === "contact" && billing.company ? (
          <p className="text-sm text-ink-soft">
            שדה ריק מוצג מפרטי החיוב של{" "}
            <Link href={paths.company(orgId, billing.company.id)} className="text-accent underline underline-offset-4">
              <bdi>{billing.company.name}</bdi>
            </Link>
            .
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}

function BillingEditForm({ orgId, recordId, billing, onDone }: { orgId: string; recordId: string; billing: RecordBilling; onDone: () => void }) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateBillingAction(orgId, billing.subject, recordId, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <Card aria-labelledby="billing-title">
      <CardHeader id="billing-title" title="עריכת פרטי חיוב" />
      <CardBody>
        <form action={formAction} className="space-y-4" noValidate>
          <FormGuard state={state} />
          <FormError message={failure?.message} />
          <BillingFields
            subject={billing.subject}
            values={failure?.values ?? billingFormValues(billing.own)}
            errors={failure?.fieldErrors ?? {}}
            priceLists={billing.priceLists}
            fromCompanyHint={billing.subject === "contact" && billing.company !== null}
          />
          <div className="flex flex-wrap gap-2 pt-1">
            <SubmitButton size="sm">שמירה</SubmitButton>
            <Button variant="ghost" size="sm" onClick={onDone}>
              ביטול
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

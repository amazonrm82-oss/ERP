"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import type { FormState } from "@/lib/action-result";
import type { StageKind } from "@/lib/database.types";
import { paths } from "@/lib/paths";

import { updateDealAction } from "../actions";

type Option = { id: string; name: string };

export type DealDetailsView = {
  id: string;
  name: string;
  status: StageKind;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  lostReason: string | null;
  // formatted on the server so server and browser output cannot differ
  amountText: string;
  amountInput: string;
  expectedCloseDate: string | null;
  expectedCloseText: string | null;
  closedAtText: string | null;
  ownerName: string | null;
  createdAtText: string;
};

type Props = { orgId: string; deal: DealDetailsView; contacts: Option[]; companies: Option[]; canEdit: boolean };

const linkClass = "text-accent underline underline-offset-4";

/** Deal details that switch in place between reading and editing. */
export function DealDetailsCard({ orgId, deal, contacts, companies, canEdit }: Props) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <DealEditForm orgId={orgId} deal={deal} contacts={contacts} companies={companies} onDone={() => setEditing(false)} />;
  }

  return (
    <Card aria-labelledby="deal-details-title">
      <CardHeader
        id="deal-details-title"
        title="פרטי העסקה"
        action={
          canEdit ? (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              עריכה
            </Button>
          ) : null
        }
      />
      <CardBody>
        <DetailList>
          <Detail label="שווי" value={deal.amountText} />
          <Detail
            label="איש קשר"
            value={
              deal.contactId && deal.contactName ? (
                <Link href={paths.contact(orgId, deal.contactId)} className={linkClass}>
                  {deal.contactName}
                </Link>
              ) : null
            }
          />
          <Detail
            label="חברה"
            value={
              deal.companyId && deal.companyName ? (
                <Link href={paths.company(orgId, deal.companyId)} className={linkClass}>
                  {deal.companyName}
                </Link>
              ) : null
            }
          />
          <Detail label="סגירה צפויה" value={deal.expectedCloseText} />
          {deal.closedAtText ? <Detail label="נסגרה" value={deal.closedAtText} /> : null}
          {deal.status === "lost" ? <Detail label="סיבת הפסד" value={deal.lostReason} /> : null}
          <Detail label="בעלים" value={deal.ownerName} />
          <Detail label="נוצרה" value={deal.createdAtText} />
        </DetailList>
      </CardBody>
    </Card>
  );
}

type EditProps = { orgId: string; deal: DealDetailsView; contacts: Option[]; companies: Option[]; onDone: () => void };

function DealEditForm({ orgId, deal, contacts, companies, onDone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateDealAction(orgId, deal.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;
  const values = failure?.values;
  const errors = failure?.fieldErrors ?? {};
  const contactValue = values?.contact_id ?? deal.contactId ?? "";
  const companyValue = values?.company_id ?? deal.companyId ?? "";

  return (
    <Card aria-labelledby="deal-details-title">
      <CardHeader id="deal-details-title" title="עריכת העסקה" />
      <CardBody>
        <form action={formAction} className="space-y-4" noValidate>
          <FormError message={failure?.message} />
          <TextField
            label="שם העסקה"
            name="name"
            required
            maxLength={200}
            autoComplete="off"
            defaultValue={values?.name ?? deal.name}
            error={errors.name}
          />
          <TextField
            label="שווי (₪)"
            name="amount"
            dir="ltr"
            inputMode="decimal"
            autoComplete="off"
            defaultValue={values?.amount ?? deal.amountInput}
            error={errors.amount}
          />
          <SelectField key={`contact-${contactValue}`} label="איש קשר" name="contact_id" defaultValue={contactValue} error={errors.contact_id}>
            <option value="">ללא איש קשר</option>
            {contacts.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.name}
              </option>
            ))}
          </SelectField>
          <SelectField key={`company-${companyValue}`} label="חברה" name="company_id" defaultValue={companyValue} error={errors.company_id}>
            <option value="">ללא חברה</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id}>
                {company.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="תאריך סגירה צפוי"
            name="expected_close_date"
            type="date"
            defaultValue={values?.expected_close_date ?? deal.expectedCloseDate ?? ""}
            error={errors.expected_close_date}
          />
          {deal.status === "lost" ? (
            <TextareaField
              label="סיבת הפסד"
              name="lost_reason"
              maxLength={500}
              defaultValue={values?.lost_reason ?? deal.lostReason ?? ""}
              error={errors.lost_reason}
            />
          ) : (
            <input type="hidden" name="lost_reason" value={deal.lostReason ?? ""} />
          )}
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

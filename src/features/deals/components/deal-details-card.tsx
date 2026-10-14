"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { useEditFocus } from "@/features/data-quality/use-edit-focus";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError, FormNotice } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { SubmitButton } from "@/components/ui/submit-button";
import { FormGuard } from "@/components/ui/unsaved-changes";
import { CustomFieldDetails } from "@/features/custom-fields/components/custom-field-details";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import { LossFields } from "@/features/deal-loss-reasons/components/loss-fields";
import type { LossReasonOption } from "@/features/deal-loss-reasons/queries";
import { COMPETITOR_MAX } from "@/features/deal-loss-reasons/schema";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import type { StageKind } from "@/lib/database.types";
import { paths } from "@/lib/paths";

import { updateDealAction } from "../actions";
import { dealValueHint, dealValueNote } from "../recurring";
import { RecurringFields } from "./recurring-fields";

type Option = { id: string; name: string };

export type DealDetailsView = {
  id: string;
  name: string;
  status: StageKind;
  contactId: string | null;
  contactName: string | null;
  companyId: string | null;
  companyName: string | null;
  // what the deal was lost with: the reason's current name, else the stored text
  lostReason: string | null;
  // DEAL-03: the reason picked from the list (null for old free text), and the competitor
  lossReason: LossReasonOption | null;
  competitor: string | null;
  // formatted on the server so server and browser output cannot differ
  amountText: string;
  amountInput: string;
  // DEAL-07: the value is computed (deals.amount_auto); DLI-03: from the lines or the first year
  amountAuto: boolean;
  amountSource: string | null;
  expectedCloseDate: string | null;
  expectedCloseText: string | null;
  // DEAL-07: recurring revenue (kind null = one-time); texts formatted on the server
  recurring: {
    kind: string | null;
    kindText: string;
    amountText: string | null;
    amountInput: string;
    // DLI-03: the recurring amount follows the product lines (deals.recurring_amount_auto)
    amountAuto: boolean;
    startDate: string | null;
    startText: string | null;
    renewalDate: string | null;
    renewalText: string | null;
  };
  closedAtText: string | null;
  ownerName: string | null;
  createdAtText: string;
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues; builtins?: Record<string, string | null> };
};

// lossReasons: the organization's active loss reasons (DEAL-03)
type Props = { orgId: string; deal: DealDetailsView; contacts: Option[]; companies: Option[]; lossReasons: LossReasonOption[]; canEdit: boolean; focus?: string | null };

const linkClass = "text-accent underline underline-offset-4";

/** Deal details that switch in place between reading and editing. */
export function DealDetailsCard({ orgId, deal, contacts, companies, lossReasons, canEdit, focus }: Props) {
  // DQL-01: a missing field on the completeness card opens the card for editing at that input
  const [editing, setEditing] = useState(Boolean(focus) && canEdit);
  // a message from the last save (PL-03: the existing lines keep their prices when the customer changes)
  const [notice, setNotice] = useState<string | null>(null);
  useEditFocus("deal-details-title", focus, editing);
  const note = dealValueNote(deal.amountAuto, deal.amountSource);

  if (editing) {
    return (
      <DealEditForm
        orgId={orgId}
        deal={deal}
        contacts={contacts}
        companies={companies}
        lossReasons={lossReasons}
        onDone={(message) => {
          setNotice(message ?? null);
          setEditing(false);
        }}
      />
    );
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
        <FormNotice message={notice} className="mb-4" />
        <DetailList>
          <Detail label="שווי" value={note ? `${deal.amountText} ${note}` : deal.amountText} />
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
          <Detail label="סוג עסקה" value={deal.recurring.kindText} />
          {deal.recurring.kind ? (
            <>
              <Detail label="סכום חוזר" value={deal.recurring.amountText} />
              <Detail label="תאריך התחלה" value={deal.recurring.startText} />
              <Detail label="תאריך חידוש" value={deal.recurring.renewalText} />
            </>
          ) : null}
          {deal.closedAtText ? <Detail label="נסגרה" value={deal.closedAtText} /> : null}
          {deal.status === "lost" ? <Detail label="סיבת הפסד" value={deal.lostReason} /> : null}
          {deal.competitor || deal.status === "lost" ? <Detail label="מתחרה" value={deal.competitor} /> : null}
          <Detail label="אחראי" value={deal.ownerName} />
          <Detail label="נוצרה" value={deal.createdAtText} />
          <CustomFieldDetails definitions={deal.custom.definitions} values={deal.custom.values} objectType="deal" builtins={deal.custom.builtins} />
        </DetailList>
      </CardBody>
    </Card>
  );
}

type EditProps = { orgId: string; deal: DealDetailsView; contacts: Option[]; companies: Option[]; lossReasons: LossReasonOption[]; onDone: (message?: string) => void };

function DealEditForm({ orgId, deal, contacts, companies, lossReasons, onDone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateDealAction(orgId, deal.id, prev, formData);
    if (result?.ok) {
      onDone(result.message);
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
          <FormGuard state={state} />
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
            hint={dealValueHint(deal.amountAuto, deal.amountSource)}
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
          <RecurringFields
            initial={{ kind: deal.recurring.kind, amount: deal.recurring.amountInput, start: deal.recurring.startDate ?? "", renewal: deal.recurring.renewalDate ?? "" }}
            submitted={values}
            errors={errors}
            amountAuto={deal.recurring.amountAuto}
          />
          {deal.status === "lost" ? (
            <LossFields
              key={`loss-${values?.lost_reason_id ?? deal.lossReason?.id ?? ""}`}
              reasons={lossReasons}
              current={
                values?.lost_reason_id !== undefined
                  ? (lossReasons.find((reason) => reason.id === values.lost_reason_id) ?? (deal.lossReason?.id === values.lost_reason_id ? deal.lossReason : null))
                  : deal.lossReason
              }
              oldText={deal.lossReason ? null : deal.lostReason}
              competitor={values?.competitor ?? deal.competitor}
              errors={errors}
            />
          ) : (
            <TextField
              label="מתחרה"
              name="competitor"
              maxLength={COMPETITOR_MAX}
              autoComplete="off"
              defaultValue={values?.competitor ?? deal.competitor ?? ""}
              error={errors.competitor}
            />
          )}
          <CustomFieldInputs definitions={deal.custom.definitions} stored={deal.custom.values} submitted={values} errors={errors} objectType="deal" builtins={deal.custom.builtins} />
          <div className="flex flex-wrap gap-2 pt-1">
            <SubmitButton size="sm">שמירה</SubmitButton>
            <Button variant="ghost" size="sm" onClick={() => onDone()}>
              ביטול
            </Button>
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

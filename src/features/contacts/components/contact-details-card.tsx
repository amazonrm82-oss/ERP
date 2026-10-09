"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Detail, DetailList } from "@/components/detail-list";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FormError } from "@/components/ui/feedback";
import { SubmitButton } from "@/components/ui/submit-button";
import type { CompanyOption } from "@/features/companies/queries";
import { CustomFieldDetails } from "@/features/custom-fields/components/custom-field-details";
import { CustomFieldInputs } from "@/features/custom-fields/components/custom-field-inputs";
import type { CustomValues, FieldDefinition } from "@/features/custom-fields/types";
import type { FormState } from "@/lib/action-result";
import { paths } from "@/lib/paths";

import { updateContactAction } from "../actions";
import { ContactFields, type ContactValues } from "./contact-fields";

export type ContactDetailsView = ContactValues & {
  id: string;
  full_name: string | null;
  companyName: string | null;
  sourceName: string | null;
  ownerName: string | null;
  birthDateText: string | null;
  // formatted on the server so server and browser output cannot differ
  createdAtText: string;
  // active custom fields and the values stored on the record
  custom: { definitions: FieldDefinition[]; values: CustomValues };
};

type Props = { orgId: string; contact: ContactDetailsView; companies: CompanyOption[]; canEdit: boolean };

/** Contact details that switch in place between reading and editing. */
export function ContactDetailsCard({ orgId, contact, companies, canEdit }: Props) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    // mounted only while editing, so every edit starts with a clean form state
    return <ContactEditForm orgId={orgId} contact={contact} companies={companies} onDone={() => setEditing(false)} />;
  }

  return (
    <Card aria-labelledby="contact-details-title">
      <CardHeader
        id="contact-details-title"
        title="פרטי איש הקשר"
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
          <Detail label="שם מלא" value={contact.full_name} />
          <Detail label="טלפון" value={contact.phone} ltr />
          <Detail label="אימייל" value={contact.email} ltr />
          <Detail label="תפקיד" value={contact.job_title} />
          <Detail
            label="חברה"
            value={
              contact.company_id && contact.companyName ? (
                <Link href={paths.company(orgId, contact.company_id)} className="text-accent underline underline-offset-4">
                  {contact.companyName}
                </Link>
              ) : null
            }
          />
          <Detail label="יום הולדת" value={contact.birthDateText} />
          <Detail label="מקור" value={contact.sourceName} />
          <Detail label="אחראי" value={contact.ownerName} />
          <Detail label="נוצר" value={contact.createdAtText} />
          <CustomFieldDetails definitions={contact.custom.definitions} values={contact.custom.values} />
        </DetailList>
      </CardBody>
    </Card>
  );
}

type EditProps = { orgId: string; contact: ContactDetailsView; companies: CompanyOption[]; onDone: () => void };

function ContactEditForm({ orgId, contact, companies, onDone }: EditProps) {
  const [state, formAction] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await updateContactAction(orgId, contact.id, prev, formData);
    if (result?.ok) {
      onDone();
    }
    return result;
  }, null);
  const failure = state && !state.ok ? state : null;

  return (
    <Card aria-labelledby="contact-details-title">
      <CardHeader id="contact-details-title" title="עריכת איש הקשר" />
      <CardBody>
        <form action={formAction} className="space-y-4" noValidate>
          <FormError message={failure?.message} />
          <ContactFields values={failure?.values ?? contact} errors={failure?.fieldErrors ?? {}} companies={companies} />
          <CustomFieldInputs
            definitions={contact.custom.definitions}
            stored={contact.custom.values}
            submitted={failure?.values}
            errors={failure?.fieldErrors}
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
